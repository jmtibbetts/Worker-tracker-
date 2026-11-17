'use strict';

const path = require('path');
const fs = require('fs');
const { Db } = require('./db');
const { createApp } = require('./app');
const { newToken } = require('./auth');

const DATA_DIR = process.env.WT_SERVER_DATA_DIR || path.join(__dirname, '..', 'data');
const PORT = Number(process.env.PORT) || 4800;
const HOST = process.env.HOST || '0.0.0.0';

function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new Db(path.join(DATA_DIR, 'worker-tracker.db'));

  // First-run bootstrap: create the enrollment token and the initial admin.
  if (!db.getConfig('enrollment_token')) db.setConfig('enrollment_token', newToken(18));
  if (!db.getConfig('org_name')) db.setConfig('org_name', process.env.WT_ORG_NAME || 'Your Organization');

  if (db.adminCount() === 0) {
    const email = process.env.WT_ADMIN_EMAIL || 'admin@example.com';
    const password = process.env.WT_ADMIN_PASSWORD || newToken(9);
    db.createAdmin(email, password, 'Administrator', 'owner');
    console.log('\n=== Worker Tracker server: initial admin created ===');
    console.log(`  Admin email:    ${email}`);
    if (!process.env.WT_ADMIN_PASSWORD) console.log(`  Admin password: ${password}   (shown once — store it now)`);
    console.log(`  Enrollment token: ${db.getConfig('enrollment_token')}`);
    console.log('====================================================\n');
  }

  const server = createApp(db, { log: (...a) => process.env.WT_VERBOSE && console.log('[wt]', ...a) });
  server.listen(PORT, HOST, () => {
    console.log(`Worker Tracker server listening on http://${HOST}:${PORT}`);
    console.log(`Admin console: http://${HOST}:${PORT}/   Data: ${DATA_DIR}`);
  });

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      server.close();
      db.close();
      process.exit(0);
    });
  }
}

main();
