import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { AssistantService } from '../src/main/agent/service';
import { ToolHost } from '../src/main/tools';
import { defaults } from '../src/main/settings';
import type { Settings } from '../src/shared/types';
async function main(){
 if(!process.env.CODEX_HOME)throw Error('Explicit CODEX_HOME required.');
 const directory=await mkdtemp(path.resolve('.local/project-060-')), workspace=path.join(directory,'workspace');await mkdir(workspace);
 await writeFile(path.join(workspace,'package.json'),JSON.stringify({name:'dragon-project-check',private:true,scripts:{build:'node build.cjs',test:'node test.cjs'}}));
 await writeFile(path.join(workspace,'build.cjs'),"require('fs').writeFileSync('build-result.txt',require('fs').readFileSync('hello.txt','utf8')); console.log('build success');");
 await writeFile(path.join(workspace,'test.cjs'),"require('assert').strictEqual(require('fs').readFileSync('build-result.txt','utf8').trim(),'project-ok'); console.log('test success');");
 const settings:Settings={...structuredClone(defaults),projects:[{id:'test-project',name:'本机验收',application:'codex',directory:workspace,threadId:'01a1670a-8733-7272-a5dd-b318692d3daa',threadTitle:'本机验收'}],activeProjectId:'test-project'};
 let service:AssistantService;
 const host=new ToolHost({getGrant:()=>({folders:[workspace],origins:[]}),getTaskId:()=>service.getSnapshot().activeTurnId,requestApproval:input=>service.requestApproval(input),onBrowserChange:()=>{}});
 service=new AssistantService({dataDir:path.join(directory,'user-data'),getSettings:()=>settings,toolHost:host,openExternal:async()=>{throw Error('No login flow allowed.');}});
 const approvals:any[]=[];let answers=0;
 try{
  await service.initialize(); const available=service.getSnapshot().models;const selected=available.find(m=>/gpt-6\.1$/.test(m.id))??available.find(m=>m.isDefault)??available[0];settings.model=selected.id;settings.reasoningByModel={[selected.id]:selected.supportedReasoningEfforts?.find(e=>e.reasoningEffort==='low')?.reasoningEffort??selected.defaultReasoningEffort!};
  await service.send('这是桌宠项目权限的隔离验收。只在当前项目目录工作。先用 request_user_input 提问一个选择题：是否开始本机项目测试（选项：开始测试、暂不开始）。得到开始测试回答后，在当前目录创建 hello.txt，内容恰好 project-ok；运行现有 npm run build 和 npm test。不要修改已有 package.json、build.cjs、test.cjs，不安装依赖、不访问网页、不改其他位置、不删除文件、不推送。构建测试成功后简短报告结果。');
  const deadline=Date.now()+180000,seen=new Set<string>();
  while(Date.now()<deadline){
   const state=service.getSnapshot();if(state.error)throw Error(state.error);
   for(const request of state.pending){if(seen.has(request.id))continue;seen.add(request.id);
    if(request.kind==='question'){answers++;await service.answer({id:request.id,answers:Object.fromEntries(request.questions.map(q=>[q.id,['开始测试']]))});}
    else {approvals.push(request); // Approve only the exact, benign sandboxed build/test in this fixture.
      const details=request.details.join('\n');const safe=details.includes(workspace)&&!/(Remove-Item|del |rm |publish|push|outside|扩大|额外权限|network)/i.test(details)&&/(npm(?:\.cmd)? (?:run build|test))/.test(details);
      await service.approve(request.id,safe?'allow':'deny');
    }
   }
   if(!state.activeTurnId&&!state.pending.length&&state.messages.some(m=>m.role==='assistant'))break;
   await new Promise(r=>setTimeout(r,250));
  }
  const state=service.getSnapshot();await writeFile(path.join(directory,'trace.json'),JSON.stringify({approvals,messages:state.messages},null,2));assert.equal(state.activeTurnId,null,'Project task must complete.');assert(answers>0);
  assert.equal((await readFile(path.join(workspace,'build-result.txt'),'utf8')).trim(),'project-ok');
  await writeFile(path.join(directory,'result.json'),JSON.stringify({ok:true,model:settings.model,answers,approvals,threadId:state.threadId,messages:state.messages},null,2));console.log(directory);
 }finally{await service.dispose();}
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
