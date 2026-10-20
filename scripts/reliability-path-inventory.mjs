import ts from 'typescript';
import {readFile,writeFile,mkdir,readdir} from 'node:fs/promises';
import {resolve,relative,join} from 'node:path';
import {createHash} from 'node:crypto';

// Structural discovery only. A call/return inventory is never an acceptance proof.
const root=resolve('.'),output=resolve(process.argv[2]??'.codex-checkpoints/framework-reliability-handoff/continuation-2026-10-20/path-inventory.json');
const config=ts.readConfigFile(join(root,'tsconfig.json'),ts.sys.readFile);
const parsed=ts.parseJsonConfigFileContent(config.config,ts.sys,root);
const program=ts.createProgram(parsed.fileNames,parsed.options),checker=program.getTypeChecker();
const files=[],functions=[],edges=[],exits=[],branches=[],hooks=[];
const hash=createHash('sha256');
const local=path=>path.replaceAll('\\','/').startsWith(root.replaceAll('\\','/')+'/src/');
const pathOf=source=>relative(root,source.fileName).replaceAll('\\','/');
const lineOf=(source,node)=>source.getLineAndCharacterOfPosition(node.getStart(source)).line+1;
const labelOf=node=>{
 if(node.name)return node.name.getText();
 const parent=node.parent;
 if(ts.isVariableDeclaration(parent)||ts.isPropertyAssignment(parent))return parent.name.getText();
 if(ts.isCallExpression(parent))return parent.expression.getText()+':callback';
 return '<anonymous>';
};
for(const source of program.getSourceFiles().filter(file=>local(file.fileName)&&!file.isDeclarationFile).sort((a,b)=>a.fileName.localeCompare(b.fileName))){
 const file=pathOf(source),content=await readFile(source.fileName,'utf8');hash.update(file).update(content);
 files.push({file,sha256:createHash('sha256').update(content).digest('hex')});
 const visit=(node,owner=file+':module')=>{
  if(ts.isFunctionLike(node)&&node.body){
   owner=file+':'+lineOf(source,node);
   functions.push({id:owner,file,line:lineOf(source,node),end_line:source.getLineAndCharacterOfPosition(node.end).line+1,
     name:labelOf(node),async:node.modifiers?.some(modifier=>modifier.kind===ts.SyntaxKind.AsyncKeyword)??false,
     review_status:'unreviewed'});
  }
  const line=lineOf(source,node);
  if(ts.isThrowStatement(node)||ts.isCatchClause(node)||ts.isReturnStatement(node))
   exits.push({file,line,owner,kind:ts.isThrowStatement(node)?'throw':ts.isCatchClause(node)?'catch':'return'});
  if(ts.isIfStatement(node)||ts.isSwitchStatement(node)||ts.isConditionalExpression(node))
   branches.push({file,line,owner,kind:ts.SyntaxKind[node.kind]});
  if(ts.isCallExpression(node)){
   const expression=node.expression,callee=expression.getText(source).slice(0,180);
   let symbol=checker.getSymbolAtLocation(ts.isPropertyAccessExpression(expression)?expression.name:expression);
   if(symbol?.flags&ts.SymbolFlags.Alias)symbol=checker.getAliasedSymbol(symbol);
   const declaration=symbol?.declarations?.find(declaration=>local(declaration.getSourceFile().fileName));
   edges.push({file,line,owner,callee,target:declaration?
     pathOf(declaration.getSourceFile())+':'+lineOf(declaration.getSourceFile(),declaration):null});
   if(/app\.(get|post|put|delete|use)$/.test(callee)||/catch$|reject$|storage\.|writePending|prepareRequestCommit|persist|fallback|recover|withRequestBudget|withInputRecovery/i.test(callee))
    hooks.push({file,line,owner,callee,argument:node.arguments[0]&&ts.isStringLiteral(node.arguments[0])?node.arguments[0].text:null});
  }
  ts.forEachChild(node,child=>visit(child,owner));
 };
 visit(source);
}
const totals={files:files.length,functions:functions.length,call_sites:edges.length,statically_linked_calls:edges.filter(edge=>edge.target).length,
 exits:exits.length,branches:branches.length,recovery_and_effect_hooks:hooks.length};
await mkdir(resolve(output,'..'),{recursive:true});
await writeFile(output,JSON.stringify({generated_at:new Date().toISOString(),source_sha256:hash.digest('hex'),
 limitations:['Structural inventory; unreviewed until mapped to runtime evidence.',
 'Dynamic dispatch, provider callbacks, external effects and reachability require manual tracing and fault injection.',
 'Returns include normal completion; their presence is not itself a reliability defect.'],totals,files,functions,edges,exits,branches,hooks},null,2));
console.log(JSON.stringify({output,totals}));
