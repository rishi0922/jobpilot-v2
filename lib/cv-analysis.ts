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

// Model + shared generation config. `gemini-2.5-flash` is currently the most
// permissive free-tier model (10 RPM, 250 requests/day, 250K tokens/min).
// `gemini-2.0-flash` is the older sibling and has been reported by some users
// to return `limit: 0` errors even on accounts that should have free quota —
// so we default to 2.5-flash for reliability.
// responseMimeType locks the output to JSON so we never see stray markdown
// fences in the response.
const MODEL_NAME = process.env.GEMINI_MODEL || 'gemini-2.5-flash'

function getJsonModel() {
  return genAI.getGenerativeModel({
    model: MODEL_NAME,
    generationConfig: {
      responseMimeType: 'application/json',
      // Low temperature for scoring consistency — we want the same CV+JD
      // pair to produce roughly the same score every time. 0.4 caused
      // generous, encouraging summaries; 0.1 makes the model behave more
      // like an honest recruiter.
      temperature: 0.1,
      // 1500 was too tight — Gemini 2.5-flash often emits a longer JSON
      // (especially when strengths/gaps lists hit 5 items each), and a
      // truncated mid-array response then fails JSON.parse. 4096 is enough
      // for any reasonable analysis result without burning the daily quota.
      maxOutputTokens: 4096,
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
 *  as inline text or as a PDF document block.
 *
 *  Scoring rubric is explicit (not "give me 3-5 strengths") because the model
 *  was previously inventing filler strengths when the JD was sparse and
 *  scoring CVs that fail explicit constraints (e.g. "no MBA") in the 30-40s
 *  instead of the 0-15 range they belong in.
 */
function buildCvAnalysisPrompt(jobDescription: string, roleType: string, cvText?: string) {
  return `You are a senior hiring manager and a tough, honest recruiter for Indian IT product and PM roles. You are NOT a career coach — do not encourage, soften, or invent positives. You score CVs against JDs the way a real hiring manager would: fast, blunt, and willing to give very low scores when the fit is weak.

Analyse the candidate's CV (provided ${cvText ? 'below as plain text' : 'as the attached PDF document'}) against this job description and respond ONLY with valid JSON matching this schema exactly:
{
  "matchScore": <0-100 integer>,
  "strengths": [<0 to 5 strings: only list things that are GENUINELY strong matches with the JD's specific requirements. Empty array is fine and often correct.>],
  "gaps": [<0 to 5 strings: real gaps relative to the JD. Empty array only if the CV genuinely covers everything stated.>],
  "suggestions": [<0 to 5 actionable, JD-specific changes. Empty array if the JD is too sparse to suggest anything meaningful.>],
  "keywords": [<0 to 12 keywords from the JD that are absent from the CV. Empty array if the JD has no real keywords.>],
  "summary": "<2-sentence honest verdict. State if the JD is too sparse to evaluate properly.>",
  "recommendedCvRole": "<APM|PM|PROJECT_MANAGER|PROGRAM_MANAGER|BUSINESS_ANALYST — best CV type for this JD>"
}

SCORING RUBRIC (apply strictly):
- 90-100: Near-perfect match. CV explicitly demonstrates every major requirement. Rare.
- 70-89: Strong match. Most requirements covered with concrete evidence.
- 50-69: Decent match. Some requirements covered, some inferred, some missing.
- 30-49: Weak match. Major requirements absent OR limited evidence for stated requirements.
- 10-29: Poor match. CV is in a different domain/seniority, OR the JD is too sparse to evaluate fairly, OR the CV violates an explicit JD constraint (e.g. JD says "no MBA" and CV has an MBA → maximum score 20).
- 0-9: Total mismatch OR the JD is one-line / not a real job description.

HARD RULES:
- If the JD has an explicit NEGATIVE constraint (e.g. "no MBA", "must not have agency experience") and the CV violates it, cap matchScore at 20. List that violation as the FIRST gap.
- If the JD is less than ~30 words, fewer than 3 substantive requirements, or otherwise too sparse to evaluate fairly, score it 5-20 and state in the summary that the JD is insufficient.
- Do NOT invent strengths to fill the array. If you can list only 1 or 2 genuine strengths, do that. Zero strengths is acceptable when the fit is poor.
- Do NOT count a strength that the JD does not require (e.g. don't list "strong technical background" as a strength if the JD never mentions technical skills).

ROLE TYPE: ${roleType}

${cvText ? `CV CONTENT:\n${cvText}\n` : ''}
JOB DESCRIPTION:
${jobDescription}

Respond with JSON only. No markdown, no explanation.`
}

/** Parse the Gemini JSON response. Because we set
 *  responseMimeType: 'application/json' on the model config, the response
 *  should already be raw JSON without markdown fences — but we still strip
 *  them defensively in case the model slips.
 *
 *  THROWS on parse failure rather than silently returning a placeholder —
 *  the route handler catches it and propagates the raw text in the error
 *  response so we can see what Gemini actually returned. Silent fallbacks
 *  here previously meant the user saw a meaningless "could not parse"
 *  result and we had no idea why. */
function parseAnalysisResponse(text: string): CVAnalysisResult {
  const stripped = text.replace(/```json|```/g, '').trim()
  try {
    const parsed = JSON.parse(stripped)
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error('Parsed value is not an object')
    }
    return parsed
  } catch (err: any) {
    console.error('[cv-analysis] JSON parse failed:', err?.message)
    console.error('[cv-analysis] raw Gemini response (first 800 chars):', stripped.slice(0, 800))
    const e: any = new Error(
      `Gemini returned non-JSON output. First 300 chars: ${stripped.slice(0, 300)}`
    )
    e.rawResponse = stripped
    throw e
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
  const stripped = text.replace(/```json|```/g, '').trim()
  try {
    return JSON.parse(stripped)
  } catch (err: any) {
    console.error('[cv-analysis:insights] JSON parse failed:', err?.message)
    console.error('[cv-analysis:insights] raw response (first 800 chars):', stripped.slice(0, 800))
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
