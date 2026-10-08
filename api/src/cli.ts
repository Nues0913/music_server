import { audioDirectory, importDirectory, positiveInteger } from './config.js';
import { connectDatabase } from './infrastructure/database.js';
import { importInbox } from './modules/ingestion/importer.js';

const [command, id] = process.argv.slice(2);
if (!['import', 'disable', 'enable'].includes(command ?? '')) {
  console.error('Usage: cli import | disable <song-id> | enable <song-id>');
  process.exitCode = 1;
} else {
  const db = await connectDatabase();
  try {
    if (command === 'import') {
      const results = await importInbox({
        db, audioRoot: audioDirectory(), inbox: importDirectory(),
        maxBytes: positiveInteger('MAX_AUDIO_BYTES', 256 * 1024 * 1024),
        minFreeBytes: positiveInteger('MIN_FREE_BYTES', 512 * 1024 * 1024),
        quotaBytes: positiveInteger('LIBRARY_QUOTA_BYTES', 10 * 1024 * 1024 * 1024),
      });
      for (const result of results) console.log(JSON.stringify(result));
      if (results.some(result => result.status === 'failed')) process.exitCode = 1;
    } else {
      if (!id) throw new Error('Missing song ID');
      const result = await db.song.update({ where: { id }, data: { status: command === 'enable' ? 'active' : 'disabled' } });
      console.log(JSON.stringify({ id: result.id, status: result.status }));
    }
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  } finally {
    await db.$disconnect();
  }
}
