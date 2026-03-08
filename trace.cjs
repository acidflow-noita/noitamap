const fs = require('fs');
const data = JSON.parse(fs.readFileSync('C:/Users/Alex/AppData/Local/Temp/tmp-21080-nxRbJfJwWLuu/stats.json'));

const main = data.find(c => c.fileName && c.fileName.startsWith('assets/main'));
const telescope = data.find(c => c.fileName && c.fileName.startsWith('assets/telescope-lib'));

if (!main) console.log('Main not found!');
if (!telescope) console.log('Telescope not found!');

if (main && telescope) {
  console.log('Main imports:', main.imports);
  
  // Find what module inside main is responsible
  const telescopeModules = Object.keys(telescope.modules);
  const mainModules = Object.keys(main.modules);
  
  console.log('\nChecking all main modules to see which one imports a telescope module:');
  
  for (const mainModPath of mainModules) {
    const modInfo = main.modules[mainModPath];
    // modInfo.importedBy might contain info, or we can just look at the raw source if it existed
  }
}
