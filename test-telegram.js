#!/usr/bin/env node
// ─── Test Telegram — diagnostic de configuration ──────────────────────────────
// Vérifie que le bot token est valide et envoie un message test à chaque chat_id configuré.
// Usage : node test-telegram.js
// Ou via GitHub Actions : workflow_dispatch sur .github/workflows/test-telegram.yml

const TELEGRAM_TOKEN          = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID_CMINE  = process.env.TELEGRAM_CHAT_ID_CMINE;
const TELEGRAM_CHAT_ID_EVERM  = process.env.TELEGRAM_CHAT_ID_EVERMINER;
const TELEGRAM_CHAT_ID_PARA   = process.env.TELEGRAM_CHAT_ID_PARAGUAY;
const TELEGRAM_CHAT_ID_MINTO  = process.env.TELEGRAM_CHAT_ID_MINTO;
const TELEGRAM_CHAT_ID        = process.env.TELEGRAM_CHAT_ID; // fallback

async function apiCall(path, body) {
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/${path}`;
  const res = await fetch(url, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

async function main() {
  console.log('🔧 Test configuration Telegram — capone watcher\n');

  // ── 1. Vérification du bot token ──
  if (!TELEGRAM_TOKEN) {
    console.error('❌ TELEGRAM_BOT_TOKEN manquant — secret non configuré dans GitHub Actions');
    process.exit(1);
  }
  console.log(`🔑 TELEGRAM_BOT_TOKEN présent (${TELEGRAM_TOKEN.slice(0, 8)}...)`);

  const me = await apiCall('getMe');
  if (!me.ok) {
    console.error(`❌ Bot token invalide : ${JSON.stringify(me)}`);
    process.exit(1);
  }
  console.log(`✅ Bot OK : @${me.result.username} (id: ${me.result.id})\n`);

  // ── 2. Test d'envoi sur chaque chat_id configuré ──
  const chats = [
    { name: 'TELEGRAM_CHAT_ID_CMINE',     id: TELEGRAM_CHAT_ID_CMINE },
    { name: 'TELEGRAM_CHAT_ID_EVERMINER', id: TELEGRAM_CHAT_ID_EVERM },
    { name: 'TELEGRAM_CHAT_ID_PARAGUAY',  id: TELEGRAM_CHAT_ID_PARA },
    { name: 'TELEGRAM_CHAT_ID_MINTO',     id: TELEGRAM_CHAT_ID_MINTO },
    { name: 'TELEGRAM_CHAT_ID (fallback)',id: TELEGRAM_CHAT_ID },
  ];

  const now = new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' });

  for (const { name, id } of chats) {
    if (!id) {
      console.log(`⏭️  ${name} : non configuré (vide)`);
      continue;
    }
    console.log(`📤 Test → ${name} (chat_id: ${id})`);
    try {
      const r = await apiCall('sendMessage', {
        chat_id: id,
        parse_mode: 'HTML',
        text: [
          `🧪 <b>Test alerte — capone watcher</b>`,
          ``,
          `✅ Configuration Telegram OK`,
          `📋 Secret: <code>${name}</code>`,
          `🕐 ${now} (Paris)`,
          ``,
          `<i>Ceci est un message de test automatique.</i>`,
        ].join('\n'),
      });
      if (r.ok) {
        console.log(`   ✅ Message envoyé (msg_id: ${r.result.message_id})`);
      } else {
        console.error(`   ❌ Échec : ${r.description || JSON.stringify(r)}`);
        if (r.error_code === 403) console.error(`      → Le bot n'est PAS membre du groupe (chat_id: ${id})`);
        if (r.error_code === 400) console.error(`      → chat_id invalide : ${id}`);
      }
    } catch (err) {
      console.error(`   ❌ Erreur réseau : ${err.message}`);
    }
  }

  console.log('\n✅ Test terminé.');
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
