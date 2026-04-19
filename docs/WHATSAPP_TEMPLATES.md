# WhatsApp Templates — Meta Approval Package

Paste these into Twilio Console → **Messaging → Content Template Builder** once the Twilio account is upgraded and a WhatsApp Business Account (WABA) sender is approved. Meta typically reviews each template within 1–2 business days.

Each approved template returns a **Content SID** (starts with `HX…`). Store that SID in the settings table so the server can send using `contentSid` instead of raw text. The settings keys the server reads are:

| Setting key | Template purpose |
|-------------|-----------------|
| `whatsapp_template_invitation_sid` | First-touch wedding invitation |
| `whatsapp_template_reminder_sid` | Reminder for non-responders |
| `whatsapp_template_thankyou_sid` | Thank-you confirmation after someone RSVPs |

## Template 1 — Invitation (Utility category, Hebrew)

**Template name:** `wedding_invitation_he`
**Language:** Hebrew (`he`)
**Category:** Utility (not Marketing — utility rates are lower and approval is faster)
**Header:** none
**Footer:** none
**Buttons:** optional "Quick reply" buttons (see below)

**Body (exactly as submitted to Meta):**
```
שלום {{1}}, בשמחה רבה אנו מזמינים אתכם לחתונה של נתנאל ועמית 🎊

📅 יום ראשון, 30 באוגוסט 2026

נשמח אם תוכלו לאשר הגעה – השיבו במספר המוזמנים מטעמכם.
```

**Variable mapping:**
- `{{1}}` → guest name

**Optional buttons (recommended):**
- Quick reply: "מגיעים"
- Quick reply: "לא מגיעים"
- Quick reply: "עוד לא יודעים"

## Template 2 — Reminder (Utility category, Hebrew)

**Template name:** `wedding_reminder_he`
**Language:** Hebrew (`he`)
**Category:** Utility

**Body:**
```
היי {{1}}, עדיין לא קיבלנו תשובה לגבי החתונה של נתנאל ועמית (30.8.2026) 💍

נשמח לדעת אם תוכלו להגיע. אפשר להשיב "מגיעים" או "לא מגיעים" או לציין מספר מוזמנים.
```

**Variable mapping:**
- `{{1}}` → guest name

## Template 3 — Thank-you (Utility category, Hebrew)

**Template name:** `wedding_thankyou_he`
**Language:** Hebrew (`he`)
**Category:** Utility

**Body:**
```
תודה {{1}}! רשמנו שאתם מגיעים – {{2}} אנשים 🎉

נתנאל ועמית מחכים לראותכם ב-30.8.2026. פרטים מלאים על המקום והשעה יישלחו קרוב יותר לתאריך.
```

**Variable mapping:**
- `{{1}}` → guest name
- `{{2}}` → number coming (`num_coming`)

## Submission checklist

For each template:
1. Log into Twilio Console (after upgrade).
2. Navigate to **Messaging → Content Template Builder → Create new**.
3. Choose **WhatsApp** channel + **Utility** category + **Hebrew** language.
4. Paste the body exactly as above (keep the `{{1}}`, `{{2}}` placeholders — don't rename).
5. Submit for approval.
6. Wait for email notification (typically 4–24 hours, occasionally 2 days).
7. Copy the Content SID (`HX…`) from the approved template and paste it into the dashboard Settings page under the matching field.

## Fallback while templates are pending approval

During the approval window the system falls back to **SMS** for business-initiated messages. Guest replies trigger a 24-hour WhatsApp session window in which the system can send free-text WhatsApp messages without a template — this path already works without any Meta approval.
