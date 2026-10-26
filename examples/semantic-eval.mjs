// Authored synthetic examples only. No messages, identities, or rules from a live account.
const pair = (id, ro, en, labels, detection) => [
  { id: `${id}-ro`, language: 'ro', text: ro, labels, detection },
  { id: `${id}-en`, language: 'en', text: en, labels, detection },
];
const negative = { payment: false, meeting: false, reminder: false, invoice: false };
const monitor = {
  id: 'build', kind: 'semantic', name: 'Build failed',
  condition: 'A build or deployment failed and needs my attention.',
  category: 'reminder', threshold: 0.78,
};

export const cases = [
  ...pair('invoice', 'Factura pentru serviciul tău este disponibilă în cont și trebuie achitată.',
    'Your service invoice is available in your account and needs payment.',
    { payment: true, invoice: true, promotional: false, personal_obligation: true, transactional: true, recipient_specific: true }, 'payment'),
  ...pair('invoice-marketing', 'Descoperă aplicația noastră de facturare! Creează facturi pentru clienți. Încearcă gratuit.',
    'Discover our invoicing app! Create invoices for customers. Try it free.',
    { ...negative, promotional: true, personal_obligation: false, transactional: false, recipient_specific: false }, null),
  ...pair('receipt', 'Plata ta a fost înregistrată. Aceasta este chitanța. Nu mai ai nimic de achitat sau de făcut.',
    'Your payment was received. This is your receipt. Nothing remains to pay or do.',
    { ...negative, promotional: false, personal_obligation: false, transactional: true, recipient_specific: true }, null),
  ...pair('contribution', 'Te rog să achiți contribuția pentru excursia la care te-ai înscris.',
    'Please pay your contribution for the trip you signed up for.',
    { payment: true, invoice: false, promotional: false, personal_obligation: true }, 'payment'),
  ...pair('meeting', 'Programarea ta la consultație este confirmată pentru mâine la ora 14:30. Te așteptăm.',
    'Your consultation appointment is confirmed for tomorrow at 14:30. We expect you there.',
    { meeting: true, payment: false, invoice: false, promotional: false, recipient_specific: true }, 'meeting'),
  ...pair('form', 'Trebuie să semnezi și să trimiți formularul pentru dosarul tău. Așteptăm documentul completat de tine.',
    'You need to sign and return the form for your application. We are waiting for your completed document.',
    { reminder: true, payment: false, meeting: false, invoice: false, promotional: false, personal_obligation: true }, 'reminder'),
  ...pair('voucher', 'Ai un cupon personal, netransferabil, de 20%. Expiră azi! Cumpără acum dacă dorești.',
    'Your personal, non-transferable 20% voucher expires today! Buy now if you wish.',
    { ...negative, urgency: false, promotional: true, personal_obligation: false, transactional: false, recipient_specific: false }, null),
  ...pair('article', 'Buletin săptămânal: în exemplul istoric din 12 martie, prețul era 50 EUR. Citește analiza și distribuie articolul.',
    'Weekly newsletter: in the historical example on March 12, the price was EUR 50. Read the analysis and share the article.',
    { ...negative, promotional: true, personal_obligation: false, transactional: false, recipient_specific: false }, null),
  ...pair('urgent-security', 'Accesul la contul tău va fi blocat astăzi dacă nu confirmi acum cererea de recuperare inițiată de tine.',
    'Your account access will be blocked today unless you confirm the recovery request you initiated now.',
    { reminder: true, invoice: false, urgency: true, promotional: false, personal_obligation: true, transactional: true, recipient_specific: true }, 'reminder'),
  ...pair('social', 'Mulțumesc pentru ajutor! O seară frumoasă.', 'Thanks for your help! Have a lovely evening.',
    { ...negative, urgency: false, promotional: false, personal_obligation: false }, null),
  {
    id: 'bulk-real-invoice-ro', language: 'ro', text: 'Factura ta pentru abonamentul activ este atașată. Ai de achitat suma datorată.',
    options: { messageContext: { channel: 'gmail', conversationKind: 'mailbox', gmailHints: { categoryPromotions: true, hasListUnsubscribe: true } } },
    labels: { invoice: true, promotional: false, transactional: true, recipient_specific: true }, detection: 'payment',
  },
  {
    id: 'date-ro', language: 'ro', text: 'Programarea ta este pe 20 octombrie 2026 la ora 18:45. Trebuie să participi.',
    options: { extractDate: true }, labels: { meeting: true, actionable_date: true },
    choices: { date_mode: 'absolute', date_day: '20', date_month: '10', date_year: '2026', date_hour: '18', date_minute: '45' },
    detection: 'meeting', dueAt: '2026-10-20T15:45:00.000Z',
  },
  {
    id: 'date-en', language: 'en', text: 'You must submit your signed form tomorrow by 16:30.',
    options: { extractDate: true }, labels: { reminder: true, actionable_date: true },
    choices: { date_mode: 'relative', date_anchor: 'tomorrow', date_hour: '16', date_minute: '30' },
    detection: 'reminder', dueAt: '2026-10-18T13:30:00.000Z',
  },
  {
    id: 'optional-date-ro', language: 'ro', text: 'Cuponul opțional de reducere expiră mâine la 23:59. Cumpără doar dacă dorești.',
    options: { extractDate: true }, labels: { ...negative, actionable_date: false, promotional: true, personal_obligation: false },
    choices: { date_mode: 'none' }, detection: null, dueAt: null,
  },
  {
    id: 'context-cancel-ro', language: 'ro', text: 'Anulăm programarea de mâine. Nu mai trebuie să vii.',
    options: { contextAware: true, context: [{ direction: 'incoming', text: 'Programarea ta este mâine la ora 10.' }] },
    labels: { meeting: true, cancels_previous: true, reply_needed: false }, detection: 'meeting',
  },
  {
    id: 'context-change-en', language: 'en', text: 'Your appointment is moved to 11:00. Please confirm that you can attend.',
    options: { contextAware: true, context: [{ direction: 'incoming', text: 'Your appointment is at 10:00 tomorrow.' }] },
    labels: { meeting: true, changes_previous: true, cancels_previous: false, reply_needed: true }, detection: 'meeting',
  },
  { id: 'monitor-ro', language: 'ro', text: 'Compilarea aplicației tale a eșuat. Trebuie să repari eroarea înainte de publicare.',
    monitors: [monitor], labels: { monitor_0: true }, detection: 'reminder' },
  { id: 'monitor-negative-en', language: 'en', text: 'Our newsletter explains how to prevent build failures. Read it if interested.',
    monitors: [monitor], labels: { ...negative, monitor_0: false }, detection: null },
  {
    id: 'long-tail-ro', language: 'ro',
    text: `${'Acesta este un paragraf informativ despre activități trecute, fără cerințe pentru cititor. '.repeat(40)}\n\nFactura ta curentă este atașată și trebuie achitată.`,
    labels: { invoice: true, payment: true }, detection: 'payment',
  },
];
