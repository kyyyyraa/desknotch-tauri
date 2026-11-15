// Test the LaTeX cleaner with the exact text from the user's screenshot.
const fs = require('fs');
const path = require('path');
const BS = String.fromCharCode(92);
const helper = fs.readFileSync(path.join(__dirname, 'math-helper.js'), 'utf8');
fs.writeFileSync(path.join(__dirname, '_math-test-tmp.js'), helper + '\nmodule.exports = { dnDeMath: dnDeMath };\n');
const { dnDeMath } = require('./_math-test-tmp.js');

const samples = [
  'Fungsi: $f(x) = 10 x - x^2$',
  '$$x$ = x_(min) + ' + BS + 'frac(desimal)(2^n - 1) ' + BS + 'times (x_(max) - x_(min))$$',
  'Dengan n=5, maka 2^5 - 1 = 31',
  'K 10100 20 20/31 x 10 = 6.452',
  'Rumus: $' + BS + 'alpha + ' + BS + 'beta = ' + BS + 'gamma$ dan $' + BS + 'sqrt{x} ' + BS + 'le 10$',
  'Area: ' + BS + 'frac{1}{2} * 3 ' + BS + 'approx 1.5',
  'Sub: a_{ij} and x^{12} and ' + BS + 'pi',
  'Langkah:' + String.fromCharCode(10) + '1. x = a + b'
];
samples.forEach(function (s) {
  console.log('IN : ' + s);
  console.log('OUT: ' + dnDeMath(s));
  console.log('---');
});
