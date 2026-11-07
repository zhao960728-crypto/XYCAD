const endpoint = 'https://api.openai.com/v1/responses';

export async function explainPreview({ format, status, apiKey, model, signal }, send = fetch) {
  const response = await send(endpoint, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    redirect: 'error',
    signal,
    body: JSON.stringify({
      model,
      store: false,
      max_output_tokens: 1400,
      instructions: '你是 XYCAD 预览诊断助手。你只收到文件格式和预览状态，不能查看原图。用简体中文简短列出常见原因和本机核查步骤。区分推测与已知状态，勿声称已识别具体零件、修复图纸或验证可制造性。',
      input: JSON.stringify({ format, preview: status }),
    }),
  });
  if (!response.ok) {
    await response.body?.cancel();
    return { error: response.status === 429 ? '官方 API 请求受限，请稍后重试。' : '官方 API 暂不可用，请检查本机配置。' };
  }
  const result = await response.json();
  const text = result.output?.filter(item => item.type === 'message' && item.role === 'assistant')
    .flatMap(item => item.content ?? []).filter(item => item.type === 'output_text')
    .map(item => item.text).join('\n').trim();
  return result.status === 'completed' && text
    ? { text }
    : { error: '官方 API 未返回完整的诊断文字。' };
}
