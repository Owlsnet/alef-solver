/* Where the test harnesses keep their throwaway files: <project>/.tmp (git-ignored),
 * never the system temp folder. Each run makes (and removes) its own headless-Chrome
 * profile folder in here. */

const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', '.tmp');
fs.mkdirSync(dir, { recursive: true });

module.exports = {
  dir,
  mkdtemp: prefix => fs.mkdtempSync(path.join(dir, prefix)),
};
