// Vercel serverless function: counts pips on two dice images using Claude vision.
// Keeps the Anthropic API key server-side only.

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';
const API_KEY = process.env.ANTHROPIC_API_KEY;
const MAX_IMAGE_CHARS = 4_000_000; // generous cap for a ~1500px JPEG of the whole board zone

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }
  if (!API_KEY) {
    res.status(500).json({ error: 'server_not_configured' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = null; }
  }
  if (!body || typeof body !== 'object') {
    res.status(400).json({ error: 'bad_json' });
    return;
  }

  const image = body.image;
  if (typeof image !== 'string' || image.length === 0 || image.length > MAX_IMAGE_CHARS) {
    res.status(400).json({ error: 'bad_image' });
    return;
  }

  const content = [
    {
      type: 'text',
      text: 'Это фотография части игрового стола нард (backgammon) сразу после броска. ' +
        'На столе также может быть доска с плоскими круглыми шашками — это не кубики, не путай их с кубиками. ' +
        'Найди на фото ровно два игральных кубика (кубики с точками от 1 до 6 на гранях, лежащие где угодно в кадре) ' +
        'и определи число очков на верхней грани каждого. ' +
        'Ответь СТРОГО в виде JSON без каких-либо пояснений и без markdown-разметки, в формате ' +
        '{"die1": <1-6 или null>, "die2": <1-6 или null>}. ' +
        'Если на фото не ровно два кубика, кубик не виден чётко, размыт, частично обрезан или число очков определить нельзя — ' +
        'верни null для соответствующего кубика (или для обоих).'
    },
    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: image } }
  ];

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 100,
        messages: [{ role: 'user', content }]
      }),
      signal: controller.signal
    });
    clearTimeout(timeout);

    if (!upstream.ok) {
      const errText = await upstream.text().catch(() => '');
      console.error('detect-dice: upstream_error', upstream.status, errText.slice(0, 500));
      res.status(502).json({ error: 'upstream_error', detail: errText.slice(0, 300) });
      return;
    }

    const data = await upstream.json();
    const text = (data.content || []).map(b => b.text || '').join('').trim();
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) {
      console.error('detect-dice: parse_error, raw text:', text.slice(0, 500));
      res.status(502).json({ error: 'parse_error' });
      return;
    }

    let parsed;
    try { parsed = JSON.parse(match[0]); } catch { parsed = null; }
    if (!parsed) {
      console.error('detect-dice: parse_error, match:', match[0].slice(0, 500));
      res.status(502).json({ error: 'parse_error' });
      return;
    }

    const die1 = Number.isInteger(parsed.die1) ? parsed.die1 : null;
    const die2 = Number.isInteger(parsed.die2) ? parsed.die2 : null;
    const inRange = (n) => n === null || (n >= 1 && n <= 6);
    if (!inRange(die1) || !inRange(die2)) {
      console.error('detect-dice: out_of_range', JSON.stringify(parsed));
      res.status(502).json({ error: 'out_of_range' });
      return;
    }
    if (die1 === null || die2 === null) {
      console.log('detect-dice: model could not identify both dice', JSON.stringify(parsed));
    }

    res.status(200).json({ die1, die2 });
  } catch (err) {
    clearTimeout(timeout);
    const isAbort = err && err.name === 'AbortError';
    console.error('detect-dice: caught error', isAbort ? 'timeout' : String(err));
    res.status(isAbort ? 504 : 500).json({ error: isAbort ? 'timeout' : 'server_error' });
  }
};
