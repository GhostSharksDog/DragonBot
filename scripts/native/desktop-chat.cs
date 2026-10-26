using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Automation;

// Intentionally no general key, pointer, executable or approval-click interface.
class DesktopChat {
  [DllImport("oleacc.dll")] static extern int AccessibleObjectFromWindow(IntPtr hwnd, uint id, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out object value);
  static JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = 1048576 };
  static string Str(Dictionary<string,object> input, string key) { return input.ContainsKey(key) ? Convert.ToString(input[key]) : ""; }
  static string Normalize(string value) { return Regex.Replace(value ?? "", @"\s+", " ").Trim(); }
  static string Hash(string value) { using(var sha = SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(value))).Replace("-", "").ToLowerInvariant(); }
  static bool Flag(Dictionary<string,object> input, string key) { return input.ContainsKey(key) && input[key] is bool && (bool)input[key]; }
  static IEnumerable<AutomationElement> All(AutomationElement root, ControlType type) { return root.FindAll(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, type)).Cast<AutomationElement>().Where(e => !e.Current.IsOffscreen); }
  static ValuePattern Value(AutomationElement element) { object pattern; if(!element.TryGetCurrentPattern(ValuePattern.Pattern, out pattern)) throw new Exception("目标输入框不支持安全读写，未发送。请在目标应用手动操作。"); return (ValuePattern)pattern; }
  static AutomationElement Composer(AutomationElement editor, AutomationElement target) {
    var current=editor; var result=editor;
    for(int depth=0;depth<6;depth++) {
      current=TreeWalker.ControlViewWalker.GetParent(current);
      if(current==null || current.Equals(target) || current.Current.BoundingRectangle.Height>editor.Current.BoundingRectangle.Height+200)break;
      result=current;
    }
    return result;
  }
  static string Draft(AutomationElement editor, AutomationElement composer) {
    var raw=Value(editor).Current.Value ?? "";
    var controls=All(composer,ControlType.Button).ToArray();
    // This app exposes its CSS empty-editor placeholder as a UIA Value. Only
    // recognize the known placeholder when the empty-state voice control exists
    // and no send control exists. An ordinary draft is never cleared here.
    if(raw.Trim()=="使用 ChatGPT Work" && editor.Current.Name=="使用 ChatGPT Work"
      && controls.Any(b=>b.Current.IsEnabled && b.Current.Name=="开启语音聊天")
      && !controls.Any(b=>Regex.IsMatch(b.Current.Name,@"发送|Send",RegexOptions.IgnoreCase)))return "";
    return raw;
  }
  static object Run(Dictionary<string,object> input) {
    var operation = Str(input,"operation"); if(operation!="inspect" && operation!="send") throw new Exception("不支持的操作。");
    var title = Str(input,"title"); var fingerprint = Normalize(Str(input,"fingerprint"));
    if(title.Length==0 || (fingerprint.Length<12 && !Flag(input,"uniqueTitle"))) throw new Exception("目标对话缺少可核对的标题或消息记录。");
    var windows = new List<AutomationElement>();
    foreach(var process in Process.GetProcesses().Where(p => p.ProcessName=="ChatGPT" || p.ProcessName=="Codex")) {
      try {
        var executable=process.MainModule.FileName;
        if(!Regex.IsMatch(executable, @"\\WindowsApps\\OpenAI\.Codex_[^\\]+\\app\\", RegexOptions.IgnoreCase) && !Regex.IsMatch(executable,@"\\AppData\\Local\\(?:Programs\\)?(?:OpenAI\\)?Codex\\",RegexOptions.IgnoreCase)) continue;
        if(process.MainWindowHandle==IntPtr.Zero) continue;
        var iid=new Guid("618736e0-3c3d-11cf-810c-00aa00389b71"); object accessible;
        AccessibleObjectFromWindow(process.MainWindowHandle, unchecked((uint)-4), ref iid, out accessible);
        windows.Add(AutomationElement.FromHandle(process.MainWindowHandle));
      } catch { }
    }
    var matches=new List<Tuple<AutomationElement,AutomationElement>>();
    foreach(var window in windows) foreach(var doc in All(window,ControlType.Document)) {
      if(doc.Current.AutomationId!="RootWebArea" || Normalize(doc.Current.Name)!=Normalize(title)) continue;
      object text; if(!doc.TryGetCurrentPattern(TextPattern.Pattern,out text)) continue;
      var visible=Normalize(((TextPattern)text).DocumentRange.GetText(500000));
      // The desktop app can collapse a submitted plan into a card, omitting its text
      // from UIA. In that case require a separately verified unique stored title.
      if(visible.Contains(fingerprint) || Flag(input,"uniqueTitle")) matches.Add(Tuple.Create(window,doc));
    }
    if(matches.Count!=1) throw new Exception("尚未准确定位原对话。请打开关联对话并滚动到最近消息后重试；未输入或发送。");
    var target=matches[0].Item2;
    var editors=All(target,ControlType.Edit).Where(e=>e.Current.ClassName.Contains("ProseMirror")).ToArray();
    if(editors.Length!=1) throw new Exception("无法唯一识别目标对话输入框，未发送。");
    var editor=editors[0]; var composer=Composer(editor,target); var value=Value(editor); var draft=Draft(editor,composer);
    var buttons=All(target,ControlType.Button).ToArray();
    var busy=All(composer,ControlType.Button).Any(b=>Regex.IsMatch(b.Current.Name,@"^(停止|停止生成|Stop|Stop generating)$",RegexOptions.IgnoreCase));
    var needsResponse=buttons.Any(b=>b.Current.IsEnabled && Regex.IsMatch(b.Current.Name,@"^(允许|允许本次|允许一次|批准|批准本次|Approve|Approve once|Allow once|回答并继续|提交答案)$",RegexOptions.IgnoreCase));
    if(operation=="inspect") return new { title=target.Current.Name, draftLength=draft.Length, draftHash=Hash(draft), busy=busy, needsResponse=needsResponse };
    var prompt=Str(input,"prompt"); if(prompt.Length==0 || prompt.Length>32000) throw new Exception("接续提示词长度无效。");
    if(Hash(draft)!=Str(input,"draftHash")) throw new Exception("原对话草稿已变化，未覆盖或发送，请重新确认。");
    if(needsResponse) throw new Exception("原对话正在等待你回应或批准，请先在目标应用处理。");
    if(busy && !Flag(input,"allowBusy")) throw new Exception("原对话正在工作，未发送。可以等待结束或明确选择追加要求。");
    if(draft.Trim().Length>0 && !Flag(input,"appendDraft")) throw new Exception("原对话有未发送草稿，未覆盖。");
    var composed=draft.Trim().Length>0 ? draft.TrimEnd()+"\n\n"+prompt : prompt;
    if(value.Current.IsReadOnly) throw new Exception("原对话输入框暂不可写。");
    value.SetValue(composed);
    Thread.Sleep(120);
    // Revalidate target identity and editor contents after filling, before the only send.
    if(Normalize(target.Current.Name)!=Normalize(title) || Value(editor).Current.Value.TrimEnd('\r','\n')!=composed.TrimEnd('\r','\n')) throw new Exception("填入后的内容无法核对，已保留草稿且未发送。");
    // Send must be in the input's composer. Never invoke an answer/approval
    // button elsewhere in the conversation, even if it happens to say Submit.
    var send=All(composer,ControlType.Button).Where(b=>b.Current.IsEnabled && Regex.IsMatch(b.Current.Name,@"^(发送|发送消息|发送提示词|追加|Send|Send message|Send prompt)$",RegexOptions.IgnoreCase)).ToArray();
    if(send.Length!=1) throw new Exception("未找到唯一发送按钮，内容已保留在原对话草稿中；请手动核对，不要重复发送。");
    object invoke; if(!send[0].TryGetCurrentPattern(InvokePattern.Pattern,out invoke)) throw new Exception("发送按钮不支持安全调用，内容已保留为草稿。");
    ((InvokePattern)invoke).Invoke();
    return new { invoked=true, messageHash=Hash(composed), draftWasAppended=draft.Trim().Length>0 };
  }
  [STAThread] static void Main() {
    Console.InputEncoding=new UTF8Encoding(false); Console.OutputEncoding=new UTF8Encoding(false);
    try { var line=Console.ReadLine(); var input=json.Deserialize<Dictionary<string,object>>(line); Console.WriteLine(json.Serialize(new {ok=true,result=Run(input)})); }
    catch(Exception error) { Console.WriteLine(json.Serialize(new {ok=false,error=error.Message})); Environment.ExitCode=1; }
  }
}
