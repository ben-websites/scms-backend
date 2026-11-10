const fs = require("fs");
const file = "utils/initSportsModules.js";
let src = fs.readFileSync(file, "utf8");

const startAnchor = `    console.log("Checking and updating Sports & Management schema...");`;
const endAnchor = `    console.log("All sports-related tables verified and ready.");`;

const start = src.indexOf(startAnchor);
const end = src.indexOf(endAnchor);
if (start === -1 || end === -1 || end < start) {
  console.error("Anchors not found, aborting.", start, end);
  process.exit(1);
}

const replacement = `    // All tables, columns, constraints and indexes are defined in
    // db/schema.sql (generated from the original SQL Server database).
    // This module only seeds the sports catalogue.`;

src = src.slice(0, start) + replacement + src.slice(end + endAnchor.length);
fs.writeFileSync(file, src, "utf8");
console.log("Removed", end - start, "characters of legacy DDL.");
