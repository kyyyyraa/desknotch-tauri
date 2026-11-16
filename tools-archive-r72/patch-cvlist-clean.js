const fs = require('fs');
const vm = require('vm');
const filePath = 'D:/project liburan/pet widget/desknotch-tauri/ui/_next/static/chunks/02jdcovrpfbyy.js';
let src = fs.readFileSync(filePath, 'utf8');

function check(code, step) {
  try {
    new vm.Script(code);
    console.log('Step ' + step + ': OK');
    return true;
  } catch (e) {
    console.log('Step ' + step + ' FAILED: ' + e.message);
    process.exit(1);
  }
}

// 1. Update conversation window size to 640x420
const tConvoSize = '"conversation"===h?{width:560,height:340}';
const rConvoSize = '"conversation"===h?{width:640,height:420}';
if (src.includes(tConvoSize)) {
  src = src.replace(tConvoSize, rConvoSize);
}
check(src, '1 (Convo size 640x420)');

// 2. Add dnCleanText before cvList and use it in bubble
const tCvList = 'let cvList=cvRows=>{if(!cvRows.length)';
const rCvList = 'let dnCleanText=t=>{if(!t)return"";let s=String(t).replace(/\\r\\n/g,"\\n").replace(/```[a-z]*\\n?/gi,"").replace(/```/g,"").replace(/\\s*[-*_]{3,}\\s*/g,"\\n\\n").replace(/[ \\t]*#{1,6}[ \\t]*/g,"\\n\\n").replace(/(?:^|\\n)[ \\t]*>[ \\t]*/g,"\\n").replace(/[ \\t]+>[ \\t]*/g,"\\n").replace(/\\|[-:\\s|]+\\|/g,"\\n").replace(/\\|/g," ").replace(/\\*\\*(.+?)\\*\\*/g,"$1").replace(/(^|[^\\w*])\\*([^*\\n]+)\\*(?![\\w*])/g,"$1$2").replace(/`([^`\\n]+)`/g,"$1").replace(/^[ \\t]*[-*+][ \\t]+/gm,"• ").replace(/[ \\t]{2,}/g," ").replace(/\\n{3,}/g,"\\n\\n");return s.trim()};let cvList=cvRows=>{if(!cvRows.length)';
if (!src.includes(tCvList)) throw new Error('tCvList not found');
src = src.replace(tCvList, rCvList);

const tBubble = 'children:(dnJsonish(cvRow.text)||cvRow.text)';
const rBubble = 'children:(dnJsonish(cvRow.text)||(cvUser?cvRow.text:dnCleanText(cvRow.text)))';
if (!src.includes(tBubble)) throw new Error('tBubble not found');
src = src.replace(tBubble, rBubble);
check(src, '2 (dnCleanText in cvList)');

fs.writeFileSync(filePath, src, 'utf8');
console.log('02jdcovrpfbyy.js successfully updated and verified!');
