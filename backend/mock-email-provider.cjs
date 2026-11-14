const fs = require('node:fs');

globalThis.fetch = async (input) => {
  if (process.env.EMAIL_MOCK_SENT_FILE) {
    fs.writeFileSync(process.env.EMAIL_MOCK_SENT_FILE, String(input));
  }
  return new Response(null, { status: 202 });
};
