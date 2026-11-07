// The same group codes carry different meanings in the context, branches and lines.
export function readMLeaderContext(entity) {
  const properties = [];
  let context, branch, line;
  let inContext = false;
  for (const [code, value] of entity.groups) {
    if (!inContext) {
      if (code === 300 && value === 'CONTEXT_DATA{') {
        if (context) return null;
        inContext = true;
        context = { groups: [], branches: [] };
      } else properties.push([code, value]);
      continue;
    }
    if (code === 301 && value === '}') {
      if (branch || line) return null;
      inContext = false;
    } else if (code === 302 && value === 'LEADER{') {
      if (branch) return null;
      branch = { groups: [], lines: [] };
      context.branches.push(branch);
    } else if (code === 303 && value === '}') {
      if (!branch || line) return null;
      branch = undefined;
    } else if (branch && code === 304 && value === 'LEADER_LINE{') {
      if (line) return null;
      line = { groups: [] };
      branch.lines.push(line);
    } else if (code === 305 && value === '}') {
      if (!line) return null;
      line = undefined;
    } else {
      (line ?? branch ?? context).groups.push([code, value]);
    }
  }
  return inContext || !context ? null : { context, properties: { groups: properties } };
}
