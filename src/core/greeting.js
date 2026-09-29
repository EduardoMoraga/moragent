const GREETINGS = new Set([
  'hola', 'holi', 'hola moragent', 'buenas', 'buen dia', 'buenos dias',
  'buenas tardes', 'buenas noches', 'saludos', 'que tal',
  'hello', 'hello moragent', 'hi', 'hi moragent', 'hey', 'hey moragent', 'hiya', 'howdy', 'greetings',
  'good morning', 'good afternoon', 'good evening',
]);

export function normalizeGreeting(text) {
  return String(text ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().trim().replace(/^[¡¿]+|[.!?¡¿,;:]+$/g, '').trim().replace(/\s+/g, ' ');
}

export function isGreeting(text) {
  return GREETINGS.has(normalizeGreeting(text));
}
