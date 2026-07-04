import Anthropic from '@anthropic-ai/sdk';

export async function parsePineScriptParams(code) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set in environment');

  const client = new Anthropic({ apiKey });

  const message = await client.messages.create({
    model: 'claude-opus-4-7',
    max_tokens: 512,
    messages: [{
      role: 'user',
      content: `Analyze this Pine Script trading strategy and extract these parameters. Return ONLY a valid JSON object with these exact keys (use null for any you cannot determine with confidence):

- rrRatio: number (the risk:reward ratio for the take-profit, e.g. 1.5 means target is 1.5× the stop distance)
- sessionStart: integer in HHMM format (NY time session open, e.g. 930 for 9:30am)
- sessionEnd: integer in HHMM format (NY time session close, e.g. 1100 for 11:00am)
- direction: string — one of "LONG", "SHORT", or "BOTH"
- stopBuffer: number (dollar amount added/subtracted beyond zone boundary for the stop, e.g. 0.04)
- thresholdPct: number between 1 and 50 (volume percentage threshold for zone detection, e.g. 10)
- div: integer between 10 and 200 (number of bins for zone calculation, e.g. 50)

Pine Script code:
\`\`\`pinescript
${code}
\`\`\`

Return only the JSON object, no explanation, no markdown.`
    }]
  });

  const text = message.content[0].text.trim();
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Could not parse Claude response as JSON');
  return JSON.parse(jsonMatch[0]);
}
