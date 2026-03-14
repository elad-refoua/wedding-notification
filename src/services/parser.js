const PHRASES = {
  opted_out: ['הסר', 'stop', 'הפסק'],
  re_enable: ['חידוש'],
  undecided: [
    'עוד לא יודעים', 'צריך לבדוק', 'נחזור אליכם', 'צריך לחשוב',
    'לא בטוח', 'לא יודע', 'אולי', 'נעדכן'
  ],
  not_coming: [
    'לצערנו לא', 'לא מגיעים', 'נאלץ לוותר', 'לא יכולים',
    'לא נוכל', 'לא נגיע', 'לא באים', 'לצערנו'
  ],
  coming: [
    'שמחים להגיע', 'אישור הגעה', 'אנחנו שם', 'בטח נגיע',
    'כן נגיע', 'נהיה שם', 'מגיעים', 'בהחלט', 'נגיע', 'נבוא', 'בטח', 'כן'
  ]
};

// Sort each category by phrase length descending (longest match first)
for (const key of Object.keys(PHRASES)) {
  PHRASES[key].sort((a, b) => b.length - a.length);
}

const HEBREW_NUMBERS = {
  'שניים': 2, 'שתיים': 2, 'שנינו': 2,
  'שלושה': 3, 'שלוש': 3,
  'ארבעה': 4, 'ארבע': 4,
  'חמישה': 5, 'חמש': 5,
  'שישה': 6, 'שש': 6,
  'שבעה': 7, 'שבע': 7,
  'שמונה': 8,
  'תשעה': 9, 'תשע': 9,
  'עשרה': 10, 'עשר': 10
};

const NUM_PATTERNS = [
  /(נבוא|נגיע|מגיעים|אנחנו)\s*(\d+)/,
  /(\d+)\s*(אנשים|נפשות|מגיעים)?/
];

function parseReply(text) {
  if (!text || typeof text !== 'string') return { status: null, numComing: null };
  const cleaned = text.replace(/[.,!?;:'"()\-]/g, '').trim();

  // Level 1: Keyword matching (longest match first, priority order)
  let status = null;
  const priorities = ['opted_out', 're_enable', 'undecided', 'not_coming', 'coming'];
  for (const cat of priorities) {
    for (const phrase of PHRASES[cat]) {
      if (cleaned.includes(phrase)) { status = cat; break; }
    }
    if (status) break;
  }

  // Level 2: Number extraction (digits first, then Hebrew words)
  let numComing = null;
  for (const pattern of NUM_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      const num = parseInt(match[1]) || parseInt(match[2]);
      if (num && num > 0 && num <= 50) { numComing = num; break; }
    }
  }
  if (!numComing) {
    for (const [word, val] of Object.entries(HEBREW_NUMBERS)) {
      if (cleaned.includes(word)) { numComing = val; break; }
    }
  }

  return { status, numComing };
}

async function parseReplyWithAI(text) {
  const result = parseReply(text);
  if (result.status !== null) return result;

  // Level 3: Gemini (only when keywords didn't match)
  const { classifyWithGemini } = require('./gemini');
  const aiResult = await classifyWithGemini(text);
  if (aiResult && aiResult.confidence >= 0.7) {
    return { status: aiResult.status, numComing: aiResult.numComing };
  }

  return { status: null, numComing: null };
}

module.exports = { parseReply, parseReplyWithAI };
