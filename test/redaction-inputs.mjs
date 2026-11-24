// Inputs shared by the redaction tests on Node and in edge-runtime.

export function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

export function typicalPayload(size) {
  const lines = [
    "Hi, my order 403-5926381-7740324 placed on 2026-11-24 has not arrived.",
    "The total was Rs. 4,999 including 18% GST, invoice INV-2026-000123.",
    "Sure! I can see tracking number 789456123012 with Delhivery, ETA 26/11/2026.",
    "Please call me on +91 98765 43210 or mail priya.sharma@example.com.",
    "मेरा ऑर्डर अभी तक नहीं आया, कृपया मदद करें। कुल ₹1,299",
    "என் ஆர்டர் இன்னும் வரவில்லை, தயவுசெய்து உதவுங்கள்.",
    "Model gpt-4o-2024-08-06 replied in 1.2s; trace 4bf92f3577b34da6a3ce929d0e0e4736.",
    "I paid with card 4111 1111 1111 1111 but got charged twice 😞",
  ];
  const r = rng(1);
  const messages = [];
  let total = 0;
  while (total < size) {
    let content = "";
    for (let k = 1 + Math.floor(r() * 6); k > 0; k--) content += (content ? " " : "") + lines[Math.floor(r() * lines.length)];
    messages.push({ role: r() < 0.5 ? "user" : "assistant", content });
    total += content.length + 32;
  }
  return JSON.stringify({ messages }).slice(0, size);
}

export const ADVERSARIAL = {
  digits: (n) => "7".repeat(n),
  digits_spaced: (n) => "1 ".repeat(n / 2),
  digits_dashed: (n) => "4-".repeat(n / 2),
  card_groups: (n) => "4111 ".repeat(n / 5),
  newline_digits: (n) => "4111\n".repeat(n / 5),
  at_signs: (n) => "@".repeat(n),
  a_at: (n) => "a@".repeat(n / 2),
  a_at_dot: (n) => "a@a.".repeat(n / 4),
  local_part_no_at: (n) => "a.b-c_d+".repeat(n / 8) + "@",
  long_domain: (n) => "x@" + "a.".repeat(n / 2 - 1),
  fullwidth_at: (n) => "ａ＠".repeat(n / 2),
  fullwidth_digits: (n) => "４".repeat(n),
  zero_width_digits: (n) => "4​".repeat(n / 2),
  plus_digits: (n) => "+1".repeat(n / 2),
  plus_spaced: (n) => "+1 2 3 4 5 6 7 8 ".repeat(Math.floor(n / 17)),
  paren_digits: (n) => "+(1)".repeat(n / 4),
  sk_prefix: (n) => "sk-".repeat(Math.floor(n / 3)),
  jwt_dots: (n) => "eyJabcdefgh.".repeat(Math.floor(n / 12)),
  pem_begin: (n) => "-----BEGIN PRIVATE KEY-----".repeat(Math.floor(n / 27)),
  bearer: (n) => "Bearer ".repeat(Math.floor(n / 7)),
  pan_like: (n) => "ABCPE1234 ".repeat(n / 10),
  deny_words: (n) => "order no 9876543210 ".repeat(n / 20),
  hindi_digits: (n) => "मेरा नंबर ९८७६५४३२१० है ".repeat(Math.floor(n / 24)),
  tamil_mixed: (n) => "என் எண் 98765 43210 😀 ".repeat(Math.floor(n / 21)),
  rtl_mixed: (n) => "‮رقم 4111 1111 1111 1111‬ ".repeat(Math.floor(n / 28)),
  emoji: (n) => "😀👍🏽🇮🇳".repeat(Math.floor(n / 7)),
  lone_surrogates: (n) => "\ud800 1\udfff".repeat(n / 4),
  json_numbers: (n) => Array.from({ length: Math.floor(n / 17) }, (_, i) => String(1e15 + i * 7919)).join(","),
};

