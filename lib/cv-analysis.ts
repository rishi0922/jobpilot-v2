import Anthropic from '@anthropic-ai/sdk'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

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

export async function analyzeCV(
  cvText: string,
  jobDescription: string,
  roleType: string
): Promise<CVAnalysisResult> {
  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1000,
    messages: [{
      role: 'user',
      content: `You are an expert recruiter and career coach specialising in Indian IT product and PM roles.

Analyse this CV against this job description and respond ONLY with valid JSON matching this schema exactly:
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

CV CONTENT:
${cvText}

JOB DESCRIPTION:
${jobDescription}

Respond with JSON only. No markdown, no explanation.`
    }]
  })

  const text = response.content[0].type === 'text' ? response.content[0].text : '{}'
  try {
    return JSON.parse(text.replace(/```json|```/g, '').trim())
  } catch {
    return {
      matchScore: 0,
      strengths: [],
      gaps: ['Analysis failed — check CV format'],
      suggestions: ['Re-upload CV as clean PDF text'],
      keywords: [],
      summary: 'Could not parse analysis.',
    }
  }
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

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1000,
    messages: [{ role: 'user', content: prompt }]
  })

  const text = response.content[0].type === 'text' ? response.content[0].text : '{}'
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
  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 300,
    messages: [{
      role: 'user',
      content: `Given this job posting, which CV type should be used?

Job Title: ${jobTitle}
Description snippet: ${jobDescription?.slice(0, 500)}

Respond ONLY with JSON:
{"roleType": "<APM|PM|PROJECT_MANAGER|PROGRAM_MANAGER|BUSINESS_ANALYST>", "confidence": <0-100>, "reason": "<one sentence>"}

JSON only.`
    }]
  })

  const text = response.content[0].type === 'text' ? response.content[0].text : '{}'
  try {
    return JSON.parse(text.replace(/```json|```/g, '').trim())
  } catch {
    return { roleType: 'PM', confidence: 50, reason: 'Default fallback' }
  }
}
