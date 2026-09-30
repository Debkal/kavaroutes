import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const root=path.resolve(new URL('..',import.meta.url).pathname);
// Tracked + nonignored source: never traverse native build trees or read secrets.
let inventory;
try{inventory=execFileSync('git',['ls-files','--cached','--others','--exclude-standard','-z'],{cwd:root,encoding:'utf8'});}
catch{throw new Error('PROJECT_SOURCE_INVENTORY_FAILED');}
const paths=[...new Set(inventory.split('\0'))]
  .filter(file=>file&&!file.startsWith('archive/')&& !/(^|\/)(node_modules|dist|dist-driver|android|ios|artifacts|\.tooling|\.git|test-results)(\/|$)/.test(file)
    && /\.(?:[cm]?js|tsx?|py|sh|sql|ya?ml|html|css)$/.test(file)&&existsSync(path.join(root,file))).sort();
const category=file=>/(^|\/)(test|tests|test-support)(\/|$)|\.test\.|\.spec\./.test(file)?'test-support'
  :/^scripts\/|\/scripts\/|\/bin\/|^\.github\//.test(file)?'tooling':file.endsWith('.sql')?'database':'application-or-runtime';
const functions=[],markers=[],violations=[];
const branchKinds=new Set([ts.SyntaxKind.IfStatement,ts.SyntaxKind.ConditionalExpression,ts.SyntaxKind.CaseClause,
  ts.SyntaxKind.ForStatement,ts.SyntaxKind.ForInStatement,ts.SyntaxKind.ForOfStatement,ts.SyntaxKind.WhileStatement,ts.SyntaxKind.DoStatement,ts.SyntaxKind.CatchClause]);
for(const file of paths){
  const source=readFileSync(path.join(root,file),'utf8');
  const lines=source.split('\n');
  lines.forEach((line,index)=>{
    if(/\b(TODO|FIXME|prototype|stub|synthetic)\b/i.test(line))markers.push({file,line:index+1,category:category(file)});
  });
  if(!/\.[cm]?js$|\.tsx?$/.test(file))continue;
  const tree=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,file.endsWith('.tsx')?ts.ScriptKind.TSX:file.endsWith('.ts')?ts.ScriptKind.TS:ts.ScriptKind.JS);
  function visit(node){
    const specifier=(ts.isImportDeclaration(node)||ts.isExportDeclaration(node))?node.moduleSpecifier
      :ts.isCallExpression(node)&&(node.expression.kind===ts.SyntaxKind.ImportKeyword||node.expression.getText(tree)==='require')?node.arguments[0]:null;
    if(specifier&&ts.isStringLiteral(specifier)&&/(?:^|\/)archive\//.test(specifier.text))violations.push({file,rule:'active-import-from-archive'});
    if(ts.isFunctionLike(node)&&node.body){
      let decisions=0;
      function count(child){
        if(ts.isFunctionLike(child))return; // Attribute nested callbacks separately.
        if(branchKinds.has(child.kind))decisions++;
        if(ts.isBinaryExpression(child)&&[ts.SyntaxKind.AmpersandAmpersandToken,ts.SyntaxKind.BarBarToken,ts.SyntaxKind.QuestionQuestionToken].includes(child.operatorToken.kind))decisions++;
        ts.forEachChild(child,count);
      }
      ts.forEachChild(node.body,count);
      const line=tree.getLineAndCharacterOfPosition(node.getStart(tree)).line+1;
      functions.push({file,line,name:node.name?.getText(tree)??(ts.isVariableDeclaration(node.parent)?node.parent.name.getText(tree):'callback'),decisions,category:category(file)});
    }
    ts.forEachChild(node,visit);
  }
  visit(tree);
}
const manifest=JSON.parse(readFileSync(path.join(root,'archive/manifest.json'),'utf8'));
let verifiedArchivedFiles=0;
for(const entry of manifest.entries)for(const original of entry.sourceFiles){
  const archived=path.join(root,'archive',original.original);
  if(!existsSync(archived)||createHash('sha256').update(readFileSync(archived)).digest('hex')!==original.sha256)violations.push({file:original.original,rule:'archive-source-mismatch'});
  else verifiedArchivedFiles++;
}
const report={schemaVersion:1,generatedAt:new Date().toISOString(),sourceFiles:paths.length,verifiedArchivedFiles,
  scope:'Whole repository first-party source, SQL, configuration and tools; generated output, secrets, dependencies and archive excluded from active-code analysis.',
  limitations:'Decision counts are a review aid, not a proof of cyclomatic complexity or correctness. Markers alone do not prove obsolescence. High-branch safety and command validation remain explicit.',
  files:paths.map(file=>({file,category:category(file)})),
  functions:functions.sort((a,b)=>b.decisions-a.decisions||a.file.localeCompare(b.file)),markers,violations};
const output=path.join(root,'artifacts/project-audit');mkdirSync(output,{recursive:true});
writeFileSync(path.join(output,'current.json'),JSON.stringify(report,null,2)+'\n');
console.log(`Project audit: ${paths.length} source/configuration files; ${verifiedArchivedFiles} archived originals verified; ${violations.length} archive boundary violations.`);
if(violations.length){for(const item of violations)console.error(`${item.rule}: ${item.file}`);process.exitCode=1;}
