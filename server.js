// Inverter PCB AI: photo -> company, model, parts, readings (Anthropic API ke saath)
const http = require('http');
const fs = require('fs');
const path = require('path');

const KEY = process.env.ANTHROPIC_API_KEY;   // Claude ke liye (paid)
const GKEY = process.env.GEMINI_API_KEY;     // Gemini ke liye (free tier ho sakta hai)
const MODEL = process.env.MODEL || (GKEY ? 'gemini-3.1-flash-lite' : 'claude-sonnet-5-5');
const PER_IP = +(process.env.PER_IP_DAILY || 30);   // ek aadmi (IP) ek din mai kitni baar
const GLOBAL = +(process.env.GLOBAL_DAILY || 500);  // poori website par ek din mai kitni baar
const PORT = process.env.PORT || 3000;

const PROMPT = `Tum ek inverter repair madadgaar ho. Neeche inverter PCB ki photo hain (pehli front/component side, doosri agar ho to back/solder side). SIRF ek JSON object do, koi aur text ya code fence nahi:
{"company":"","company_confidence":"high|medium|low|unknown","model":"","evidence":"board par dikhne wala likha hua text/logo/part code jis par pehchaan tiki hai, ya none","board_type":"jo dikhe, jaise push-pull SG3525 ya TL494","components":[{"part":"","marking":"part par likha number agar padh paye","mode":"Diode|Continuity|Ohm|DC Volt|AC Volt|Capacitance","pins":"","expected":"","bad_sign":""}],"notes":""}
Niyam: 1) Company ya model SIRF tab batao jab photo mai naam, logo, sticker ya PCB code saaf dikhe, warna company unknown likho aur andaaza mat lagao. 2) components mai wahi parts likho jo photo mai dikhte hain. Marking tabhi likho jab padh sako. 3) expected readings part ke TYPE ki aam values hon (jaise MOSFET diode mode mai Source se Drain 0.4-0.7V). Kisi ek model ki exact reading kabhi mat banao. 4) notes mai likho ki board par laga part parallel path se alag reading de sakta hai aur chalte hue same model board se tulna sabse pakka hai. 5) Saare text fields sadi Hinglish (Hindi Roman script) mai likho, part ke naam English mai.`;

let day = '', perIp = new Map(), total = 0;
function allow(ip) {
  const d = new Date().toISOString().slice(0, 10);
  if (d !== day) { day = d; perIp = new Map(); total = 0; }
  if (total >= GLOBAL) return 'global';
  const n = perIp.get(ip) || 0;
  if (n >= PER_IP) return 'ip';
  perIp.set(ip, n + 1); total++;
  return '';
}

function send(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function readBody(req, limit) {
  return new Promise((ok, no) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { no(new Error('too_large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => ok(Buffer.concat(chunks).toString('utf8')));
    req.on('error', no);
  });
}

async function identify(req, res) {
  if (!GKEY && !KEY) return send(res, 500, { error: 'Server par GEMINI_API_KEY ya ANTHROPIC_API_KEY set nahi hai.' });
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const blocked = allow(ip);
  if (blocked === 'ip') return send(res, 429, { error: 'Aaj ki limit poori ho gayi. Kal dobara try karo.' });
  if (blocked === 'global') return send(res, 429, { error: 'Aaj website ki limit poori ho gayi. Kal dobara try karo.' });
  let body;
  try { body = JSON.parse(await readBody(req, 12 * 1024 * 1024)); }
  catch (e) { return send(res, 400, { error: 'Photo bahut badi ya galat hai.' }); }
  const imgs = Array.isArray(body.images) ? body.images.slice(0, 2) : [];
  const prefix = 'data:image/jpeg;base64,';
  if (!imgs.length || imgs.some(s => typeof s !== 'string' || !s.startsWith(prefix) || s.length > 5000000))
    return send(res, 400, { error: 'Kam se kam ek saaf photo chahiye.' });
  const raw = imgs.map(s => s.slice(prefix.length));
  try {
    let text = '';
    if (GKEY) {
      const parts = raw.map(d => ({ inline_data: { mime_type: 'image/jpeg', data: d } }));
      parts.push({ text: PROMPT });
      const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(MODEL) + ':generateContent', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': GKEY },
        body: JSON.stringify({ contents: [{ parts }], generationConfig: { maxOutputTokens: 6000, responseMimeType: 'application/json' } })
      });
      const j = await r.json();
      if (!r.ok) { console.error('Gemini error', r.status, JSON.stringify(j).slice(0, 300)); return send(res, r.status === 429 ? 429 : 502, { error: r.status === 429 ? 'Abhi bahut zyada use ho gaya. Thodi der baad try karo.' : 'AI se jawab nahi aaya. Thodi der baad try karo.' }); }
      const c = (j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || [];
      text = c.map(p => p.text || '').join('');
    } else {
      const content = raw.map(d => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: d } }));
      content.push({ type: 'text', text: PROMPT });
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: MODEL, max_tokens: 2500, messages: [{ role: 'user', content }] })
      });
      const j = await r.json();
      if (!r.ok) { console.error('API error', r.status, JSON.stringify(j).slice(0, 300)); return send(res, 502, { error: 'AI se jawab nahi aaya. Thodi der baad try karo.' }); }
      text = (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    }
    if (!text) return send(res, 502, { error: 'AI ne khali jawab diya. Dusri saaf photo try karo.' });
    send(res, 200, { text });
  } catch (e) {
    console.error(e); send(res, 502, { error: 'AI se jud nahi paaya. Thodi der baad try karo.' });
  }
}

http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api/identify') return identify(req, res);
  if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return fs.createReadStream(path.join(__dirname, 'index.html')).pipe(res);
  }
  send(res, 404, { error: 'Not found' });
}).listen(PORT, () => console.log('Chal raha hai, port ' + PORT));
