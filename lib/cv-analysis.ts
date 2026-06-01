import { GoogleGenerativeAI } from '@google/generative-ai'

/**
 * CV analysis backed by Google Gemini 2.0 Flash (free tier).
 *
 * Previously this module used Anthropic's Claude Sonnet 4 via @anthropic-ai/sdk
 * which works equally well, but Anthropic is pay-per-use ($10s of API spend for
 * heavy CV iteration) whereas Gemini gives 1M input tokens/day on its free
 * tier — far more than a single user would burn even with aggressive use.
 *
 * Both SDKs natively accept PDFs as document parts (no Node-side pdf-parse
 * required), so the swap is mostly a 1:1 API translation. Gemini also supports
 * a `responseMimeType: 'application/json'` config which guarantees clean JSON
 * output without the markdown-fence stripping we needed for Claude.
 *
 * Exports the same function signatures as the Anthropic version, so callers
 * (app/api/resumes/analyze/route.ts) don't need to change.
 */

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '')

// Model + shared generation config. `gemini-2.0-flash` is generally available
// on the free tier (15 RPM, 1M input tokens/day) and is fast enough that PDF
// analysis returns in 5-15s. responseMimeType locks the output to JSON so we
// never see stray markdown fences in the response.
const MODEL_NAME = 'gemini-2.0-flash'

function getJsonModel() {
  return genAI.getGenerativeModel({
    model: MODEL_NAME,
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.4,        // a little creative for suggestions, mostly deterministic
      maxOutputTokens: 1500,
    },
  })
}

export interface CVAnalysisResult {
  matchScore: number
  strengths: string[]
  gaps: string[]
  suggestions: string[]
  keywords: string[]
  summary: string
  recommendedCvRole?: string
}

export interface PostApplicationInsight {
  successPatterns: string[]
  failPatterns: string[]
  topPerformingRoles: string[]
  cvImprovements: string[]
  keywordsThatWork: string[]
}

/** Build the analysis prompt — same regardless of whether the CV is supplied
 *  as inline text or as a PDF document block. */
function buildCvAnalysisPrompt(jobDescription: string, roleType: string, cvText?: string) {
  return `You are an expert recruiter and career coach specialising in Indian IT product and PM roles.

Analyse the candidate's CV (provided ${cvText ? 'below as plain text' : 'as the attached PDF document'}) against this job description and respond ONLY with valid JSON matching this schema exactly:
{
  "matchScore": <0-100 integer>,
  "strengths": [<3-5 strings: what aligns well>],
  "gaps": [<3-5 strings: what's missing or weak>],
  "suggestions": [<3-5 actionable improvements to the CV for this role>],
  "keywords": [<8-12 keywords from JD missing from CV>],
  "summary": "<2-sentence plain-English verdict>",
  "recommendedCvRole": "<APM|PM|PROJECT_MANAGER|PROGRAM_MANAGER|BUSINESS_ANALYST — best CV type for this JD>"
}

ROLE TYPE: ${roleType}

${cvText ? `CV CONTENT:\n${cvText}\n` : ''}
JOB DESCRIPTION:
${jobDescription}

Respond with JSON only. No markdown, no explanation.`
}

/** Parse the Gemini JSON response, with a graceful fallback. Because we set
 *  responseMimeType: 'application/json' on the model config, the response
 *  should already be raw JSON without markdown fences — but we still strip
 *  them defensively in case the model slips. */
function parseAnalysisResponse(text: string): CVAnalysisResult {
  try {
    return JSON.parse(text.replace(/```json|```/g, '').trim())
  } catch {
    return {
      matchScore: 0,
      strengths: [],
      gaps: ['Analysis failed — could not parse Gemini response'],
      suggestions: ['Try again with a shorter CV/JD, or paste CV text directly'],
      keywords: [],
      summary: 'Could not parse analysis.',
    }
  }
}

/** Analyse a CV against a JD using inline CV text. Use this when the caller
 *  already has parsed CV text (e.g. user pasted it in). */
export async function analyzeCV(
  cvText: string,
  jobDescription: string,
  roleType: string
): Promise<CVAnalysisResult> {
  const model = getJsonModel()
  const result = await model.generateContent(
    buildCvAnalysisPrompt(jobDescription, roleType, cvText)
  )
  return parseAnalysisResponse(result.response.text())
}

/** Same analysis, but with the CV supplied as a base64-encoded PDF. Gemini
 *  reads PDFs natively (text + layout) — so this avoids needing a Node-side
 *  PDF parser. The base64 string must NOT include the
 *  `data:application/pdf;base64,` prefix — strip it first. */
export async function analyzeCVFromPdfBase64(
  cvPdfBase64: string,
  jobDescription: string,
  roleType: string
): Promise<CVAnalysisResult> {
  const model = getJsonModel()
  const result = await model.generateContent([
    {
      inlineData: {
        mimeType: 'application/pdf',
        data: cvPdfBase64,
      },
    },
    { text: buildCvAnalysisPrompt(jobDescription, roleType) },
  ])
  return parseAnalysisResponse(result.response.text())
}

export async function generatePostApplicationInsights(
  applicationData: Array<{
    roleType: string
    company: string
    source: string
    status: string
    cvUsed: string
    matchScore?: number
    jobDescription?: string
  }>
): Promise<PostApplicationInsight> {
  const applied = applicationData.filter(a => a.status !== 'FOUND')
  const interviews = applicationData.filter(a => a.status === 'INTERVIEW')
  const rejected = applicationData.filter(a => a.status === 'REJECTED')

  const prompt = `You are an expert career strategist. Analyse these job application outcomes for an Indian IT job seeker applying for PM/APM/BA roles.

APPLICATION DATA (${applied.length} total, ${interviews.length} interviews, ${rejected.length} rejected):
${JSON.stringify(applied.slice(0, 50), null, 2)}

Respond ONLY with valid JSON:
{
  "successPatterns": [<3-5 patterns from applications that got interviews>],
  "failPatterns": [<3-5 patterns from rejections/no-response>],
  "topPerformingRoles": [<role types with best interview conversion>],
  "cvImprovements": [<5 specific CV changes to increase interview rate>],
  "keywordsThatWork": [<8 keywords appearing in successful JDs>]
}

JSON only. No markdown.`

  const model = getJsonModel()
  const result = await model.generateContent(prompt)
  const text = result.response.text()
  try {
    return JSON.parse(text.replace(/```json|```/g, '').trim())
  } catch {
    return {
      successPatterns: [],
      failPatterns: [],
      topPerformingRoles: [],
      cvImprovements: ['Insufficient data — apply to more jobs first'],
      keywordsThatWork: [],
    }
  }
}

export async function suggestCVForJob(
  jobTitle: string,
  jobDescription: string
): Promise<{ roleType: string; confidence: number; reason: string }> {
  // Short, structured response — separate model instance with a tight token
  // cap so we don't burn budget on a 3-line answer.
  const model = genAI.getGenerativeModel({
    model: MODEL_NAME,
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.2,
      maxOutputTokens: 300,
    },
  })

  const result = await model.generateContent(
    `Given this job posting, which CV type should be used?

Job Title: ${jobTitle}
Description snippet: ${jobDescription?.slice(0, 500)}

Respond ONLY with JSON:
{"roleType": "<APM|PM|PROJECT_MANAGER|PROGRAM_MANAGER|BUSINESS_ANALYST>", "confidence": <0-100>, "reason": "<one sentence>"}

JSON only.`
  )

  const text = result.response.text()
  try {
    return JSON.parse(text.replace(/```json|```/g, '').trim())
  } catch {
    return { roleType: 'PM', confidence: 50, reason: 'Default fallback' }
  }
}
