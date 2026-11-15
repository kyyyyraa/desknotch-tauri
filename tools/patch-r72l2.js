const fs = require('fs');
const path = require('path');
const p = path.join(__dirname, '..', 'ui', 'dn-whisper.js');
let src = fs.readFileSync(p, 'utf8');
const from = `    } catch (_) {}
    mediaStream = null;
    audioCtx = null;
    sourceNode = null;
    procNode = null;
  }`;
const to = `    } catch (_) {}
    mediaStream = null;
    audioCtx = null;
    sourceNode = null;
    procNode = null;
    // Nobody wants the mic any more: invalidate an acquisition that is still
    // in flight so it closes itself instead of opening after the fact.
    wantMic = false;
    micEpoch++;
  }`;
if (!src.includes(from)) { console.error('NOT FOUND'); process.exit(1); }
src = src.split(from).join(to);
fs.writeFileSync(p, src, 'utf8');
console.log('OK [whisper: releaseMic invalidates]');
