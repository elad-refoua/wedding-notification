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

// Level 3: Claude Haiku API fallback for ambiguous replies
async function classifyWithClaude(text) {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return { status: null, numComing: null };

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 50,
        messages: [{
          role: 'user',
          content: 'Classify this Hebrew wedding RSVP reply as COMING, NOT_COMING, UNDECIDED, or UNCLEAR. Reply with only the classification and optional number of guests. Reply: ' + text
        }]
      })
    });

    if (!response.ok) return { status: null, numComing: null };
    const data = await response.json();
    const answer = (data.content?.[0]?.text || '').trim().toUpperCase();

    const statusMap = { 'COMING': 'coming', 'NOT_COMING': 'not_coming', 'UNDECIDED': 'undecided' };
    const status = statusMap[answer.split(/\s/)[0]] || null;
    const numMatch = answer.match(/(\d+)/);
    return { status, numComing: numMatch ? parseInt(numMatch[1]) : null };
  } catch (err) {
    console.error('Claude API classification failed:', err.message);
    return { status: null, numComing: null };
  }
}

module.exports = { parseReply, classifyWithClaude };
