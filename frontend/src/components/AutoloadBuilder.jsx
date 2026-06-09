import { useState, useEffect } from 'react';

const API = '/api';

function AutoloadBuilder({ profiles, payloads, onNotification }) {
  const [sequences, setSequences] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [activeView, setActiveView] = useState('list');
  const [editSequence, setEditSequence] = useState(null);
  const [sequenceName, setSequenceName] = useState('');
  const [selectedProfile, setSelectedProfile] = useState('');
  const [steps, setSteps] = useState([]);
  const [waitTime, setWaitTime] = useState(1);
  const [waitUnit, setWaitUnit] = useState('seconds');
  const [scheduleCron, setScheduleCron] = useState('');
  const [scheduleEnabled, setScheduleEnabled] = useState(false);
  const [showAddStepMenu, setShowAddStepMenu] = useState(false);
  const [selectedPayloadForStep, setSelectedPayloadForStep] = useState(null);
  const [targetPort, setTargetPort] = useState('9021');
  const [portRetryFrom, setPortRetryFrom] = useState('1');
  const [portRetryTo, setPortRetryTo] = useState('3');
  const [klogPattern, setKlogPattern] = useState('');
  const [klogSuccessMode, setKlogSuccessMode] = useState(true);
  const [luaLogPattern, setLuaLogPattern] = useState('');
  const [inputScripts, setInputScripts] = useState([]);
  const [builtinInputScripts, setBuiltinInputScripts] = useState([]);

  // New step form state (download / extract / ftp_upload / convert)
  const [dlUrl, setDlUrl] = useState('');
  const [dlFilename, setDlFilename] = useState('');
  const [dlDestPath, setDlDestPath] = useState('/data/mkpfs');
  const [extractLocalPath, setExtractLocalPath] = useState('/data/mkpfs/archive.zip');
  const [extractDestPath, setExtractDestPath] = useState('/data/mkpfs');
  const [extractPwd, setExtractPwd] = useState('');
  const [extractDeleteAfter, setExtractDeleteAfter] = useState(false);
  const [ftpLocalPath, setFtpLocalPath] = useState('/data/mkpfs/file.ffpfsc');
  const [ftpDestPath, setFtpDestPath] = useState('/data/homebrew');
  const [convSourcePath, setConvSourcePath] = useState('/data/mkpfs/game.exfat');
  const [convMode, setConvMode] = useState('pack-file');
  const [convOutputName, setConvOutputName] = useState('');

  const fetchSequences = async () => {
    try {
      const res = await fetch(`${API}/sequences`);
      const data = await res.json();
      setSequences(data);
    } catch (err) {
      console.error('Failed to fetch sequences:', err);
    }
  };

  const fetchInputScripts = async () => {
    try {
      const [userRes, builtinRes] = await Promise.all([
        fetch(`${API}/input-scripts`),
        fetch(`${API}/input-scripts/builtin`),
      ]);
      const userData = await userRes.json();
      const builtinData = builtinRes.ok ? await builtinRes.json() : [];
      setInputScripts(Array.isArray(userData) ? userData : []);
      setBuiltinInputScripts(Array.isArray(builtinData) ? builtinData : []);
    } catch (err) {
      console.error('Failed to fetch input scripts:', err);
    }
  };

  // Lookup helper: built-in scripts have string ids like "builtin:restart",
  // user scripts have integer ids. We compare loosely so a step with either
  // form can be matched without juggling types at every call site.
  const findInputScript = (id) => {
    if (id == null) return null;
    const key = String(id);
    return (
      builtinInputScripts.find(s => String(s.id) === key) ||
      inputScripts.find(s => String(s.id) === key) ||
      null
    );
  };

  const fetchTemplates = async () => {
    try {
      const res = await fetch(`${API}/sequences/templates/list`);
      const data = await res.json();
      setTemplates(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error('Failed to fetch templates:', err);
    }
  };

  useEffect(() => {
    fetchSequences();
    fetchInputScripts();
    fetchTemplates();
  }, []);

  const humanToMs = (value, unit) => {
    const v = parseFloat(value) || 0;
    switch (unit) {
      case 'hours': return v * 3600000;
      case 'minutes': return v * 60000;
      case 'seconds': return v * 1000;
      default: return v;
    }
  };

  const addStep = (payloadId) => {
    const payload = payloads.find(p => p.id === payloadId);
    if (!payload) return;
    setSteps([...steps, { type: 'payload', payloadId, name: payload.name }]);
  };

  const addWolStep = () => {
    // keep_session defaults OFF: pre-warm already parks the session in the
    // warm cache, which holds the PS5 awake for the full TTL (180s) without
    // promoting it to the live SESSIONS pool. The next input_script /
    // rp_session step transparently resumes from the warm cache.
    setSteps([...steps, { type: 'wol', name: 'Wake / Pre-warm', keep_session: false }]);
  };

  const addCheckPortStep = () => {
    const fromStep = parseInt(portRetryFrom) || 1;
    const toStep = parseInt(portRetryTo) || 3;
    setSteps([...steps, {
      type: 'check_port',
      port: parseInt(targetPort) || 9021,
      retryFromStep: fromStep,
      retryToStep: toStep,
      name: `Check port ${targetPort} (repeat steps ${fromStep}-${toStep} on fail)`
    }]);
  };

  const addKlogReadStep = () => {
    setSteps([...steps, {
      type: 'klog_read',
      pattern: klogPattern,
      successMode: klogSuccessMode,
      name: `Read klog ${klogSuccessMode ? 'success' : 'failure'}: "${klogPattern}"`
    }]);
  };

  const addLuaLogReadStep = () => {
    setSteps([...steps, {
      type: 'lua_log_read',
      pattern: luaLogPattern,
      name: `Read Lua log: "${luaLogPattern}"`
    }]);
  };

  const addInputScriptStep = (scriptId) => {
    const script = findInputScript(scriptId);
    if (!script) return;
    // Embed the literal script content so the step keeps working even if the
    // user later renames/removes the source script (built-ins are stable, but
    // the backend prefers `step.script` over `scriptId` anyway).
    setSteps([...steps, {
      type: 'input_script',
      scriptId: script.id,
      scriptName: script.name,
      script: script.script,
      builtin: typeof script.id === 'string' && script.id.startsWith('builtin:'),
      name: `Input: ${script.name}`
    }]);
  };

  const addWaitStep = () => {
    const ms = humanToMs(waitTime, waitUnit);
    if (ms <= 0) return;
    setSteps([...steps, { type: 'wait', duration: ms, name: `Wait ${waitTime} ${waitUnit}` }]);
  };

  const addRpSessionStep = (action = 'start') => {
    setSteps([...steps, {
      type: 'rp_session',
      action,
      name: action === 'stop' ? 'Stop Remote Play session' : 'Start Remote Play session',
    }]);
  };

  const addDownloadStep = () => {
    if (!dlUrl.trim()) return;
    setSteps([...steps, {
      type: 'download',
      url: dlUrl.trim(),
      filename: dlFilename.trim() || undefined,
      dest_kind: 'local',
      dest_path: dlDestPath.trim() || '/data/mkpfs',
      name: `Download ${dlFilename || dlUrl.split('/').pop() || dlUrl}`,
    }]);
    setDlUrl('');
    setDlFilename('');
  };

  const addExtractStep = () => {
    if (!extractLocalPath.trim()) return;
    setSteps([...steps, {
      type: 'extract',
      source: 'local-fs',
      local_path: extractLocalPath.trim(),
      dest_kind: 'local-fs',
      dest_local_path: extractDestPath.trim() || undefined,
      password: extractPwd || '',
      delete_archive_after: extractDeleteAfter,
      name: `Extract ${extractLocalPath.split('/').pop()}`,
    }]);
  };

  const addFtpUploadStep = () => {
    if (!ftpLocalPath.trim()) return;
    setSteps([...steps, {
      type: 'ftp_upload',
      local_path: ftpLocalPath.trim(),
      dest_path: ftpDestPath.trim() || '/data/homebrew',
      name: `Upload ${ftpLocalPath.split('/').pop()} → ${ftpDestPath || '/data/homebrew'}`,
    }]);
  };

  const addConvertStep = () => {
    if (!convSourcePath.trim()) return;
    setSteps([...steps, {
      type: 'convert',
      mode: convMode,
      source_path: convSourcePath.trim(),
      output_name: convOutputName.trim() || undefined,
      name: `Convert (${convMode}) ${convSourcePath.split('/').pop()}`,
    }]);
  };

  const loadTemplate = (tpl) => {
    setEditSequence(null);
    setSequenceName(tpl.name);
    setSelectedProfile(profiles.find(p => p.is_default)?.id?.toString() || profiles[0]?.id?.toString() || '');
    setSteps(tpl.steps.map(s => ({ ...s })));
    setScheduleType('none');
    setScheduleEnabled(false);
    setActiveView('create');
  };

  const updateWaitStep = (index, duration) => {
    const newSteps = [...steps];
    newSteps[index] = { ...newSteps[index], duration, name: `Wait ${duration}ms` };
    setSteps(newSteps);
  };

  // Generic step patcher — used by inline editors below. Re-derives the
  // displayed `name` so the saved sequence is self-describing.
  const patchStep = (index, patch) => {
    const newSteps = [...steps];
    const current = newSteps[index];
    const merged = { ...current, ...patch };

    if (merged.type === 'input_script') {
      const sc = findInputScript(merged.scriptId);
      if (sc) {
        merged.scriptName = sc.name;
        merged.script = sc.script;
        merged.builtin = typeof sc.id === 'string' && sc.id.startsWith('builtin:');
        merged.name = `Input: ${sc.name}`;
      }
    } else if (merged.type === 'payload') {
      if (merged.payloadId) {
        const p = payloads?.find(x => x.id === merged.payloadId);
        if (p) {
          merged.payloadName = p.filename || p.name;
          merged.name = `Send ${merged.payloadName}`;
        }
      } else if (merged.payloadName) {
        merged.name = `Send ${merged.payloadName}`;
      }
    } else if (merged.type === 'check_port') {
      merged.name = `Check port ${merged.port || '?'}`;
    } else if (merged.type === 'rp_session') {
      merged.name = merged.action === 'stop' ? 'Stop Remote Play session' : 'Start Remote Play session';
    } else if (merged.type === 'download') {
      const url = merged.url || '';
      const tail = url.split('/').pop() || url;
      merged.name = url ? `Download ${tail.slice(0, 32)}` : 'Download';
    } else if (merged.type === 'extract') {
      merged.name = `Extract ${merged.local_path || ''}`.trim();
    } else if (merged.type === 'convert') {
      merged.name = `Convert ${merged.source_path || ''}`.trim();
    } else if (merged.type === 'ftp_upload') {
      merged.name = `FTP upload ${(merged.local_path || '').split('/').pop() || ''}`.trim();
    }

    newSteps[index] = merged;
    setSteps(newSteps);
  };

  const removeStep = (index) => {
    setSteps(steps.filter((_, i) => i !== index));
  };

  const moveStep = (index, direction) => {
    const newSteps = [...steps];
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= newSteps.length) return;
    [newSteps[index], newSteps[targetIndex]] = [newSteps[targetIndex], newSteps[index]];
    setSteps(newSteps);
  };

  const needsProfile = steps.some(s => ['wol', 'payload', 'check_port', 'input_script', 'ftp_upload', 'rp_session'].includes(s.type));

  const saveSequence = async () => {
    if (!sequenceName || steps.length === 0) {
      onNotification('Name and at least one step are required', 'error');
      return;
    }
    if (needsProfile && !selectedProfile) {
      onNotification('This sequence uses PS5-specific steps — pick a profile', 'error');
      return;
    }
    try {
      const res = await fetch(`${API}/sequences`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          profileId: selectedProfile || null,
          name: sequenceName,
          steps,
          scheduleCron: buildCron() || null,
          scheduleEnabled: scheduleType !== 'none' && scheduleEnabled
        })
      });
      const data = await res.json();
      if (data.success) {
        onNotification('Sequence saved', 'success');
        fetchSequences();
        resetForm();
      }
    } catch (err) {
      onNotification(err.message, 'error');
    }
  };

  const updateSequence = async () => {
    if (!editSequence || !sequenceName || steps.length === 0) {
      onNotification('Name and at least one step are required', 'error');
      return;
    }
    if (needsProfile && !selectedProfile) {
      onNotification('This sequence uses PS5-specific steps — pick a profile', 'error');
      return;
    }
    try {
      const res = await fetch(`${API}/sequences/${editSequence.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: sequenceName,
          steps,
          profileId: selectedProfile || null,
          scheduleCron: buildCron() || null,
          scheduleEnabled: scheduleType !== 'none' && scheduleEnabled
        })
      });
      const data = await res.json();
      if (data.success) {
        onNotification('Sequence updated', 'success');
        fetchSequences();
        resetForm();
      } else {
        onNotification(data.error || 'Update failed', 'error');
      }
    } catch (err) {
      onNotification(err.message, 'error');
    }
  };

  const deleteSequence = async (id) => {
    if (!confirm('Delete this sequence?')) return;
    try {
      await fetch(`${API}/sequences/${id}`, { method: 'DELETE' });
      onNotification('Sequence deleted', 'success');
      fetchSequences();
    } catch (err) {
      onNotification(err.message, 'error');
    }
  };

  const runSequence = async (id) => {
    try {
      const res = await fetch(`${API}/sequences/${id}/run`, { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        onNotification(data.message, 'success');
      } else {
        onNotification(data.error, 'error');
      }
    } catch (err) {
      onNotification(err.message, 'error');
    }
  };

  const editSequenceLoad = (seq) => {
    setEditSequence(seq);
    setSequenceName(seq.name);
    setSelectedProfile(seq.profile_id);
    setSteps(JSON.parse(seq.steps || '[]'));
    parseCronToState(seq.schedule_cron);
    setScheduleEnabled(seq.schedule_enabled === 1);
    setActiveView('edit');
  };

  const resetForm = () => {
    setEditSequence(null);
    setSequenceName('');
    setSelectedProfile(profiles.find(p => p.is_default)?.id?.toString() || '');
    setSteps([]);
    setScheduleType('none');
    setScheduleInterval(5);
    setScheduleTime('00:00');
    setScheduleEnabled(false);
    setActiveView('list');
  };

  const getStepIcon = (type) => {
    switch (type) {
      case 'wait': return '⏱';
      case 'payload': return '📦';
      case 'wol': return '📡';
      case 'check_port': return '🔌';
      case 'klog_read': return '📜';
      case 'lua_log_read': return '📝';
      case 'input_script': return '▶️';
      case 'download': return '⬇️';
      case 'extract': return '📂';
      case 'ftp_upload': return '⬆️';
      case 'convert': return '🔄';
      case 'rp_session': return '🕹️';
      default: return '•';
    }
  };

  const getWaitDisplayValue = (ms) => {
    if (ms >= 3600000) return ms / 3600000;
    if (ms >= 60000) return ms / 60000;
    if (ms >= 1000) return ms / 1000;
    return ms;
  };

  const getWaitDisplayUnit = (ms) => {
    if (ms >= 3600000) return 'hours';
    if (ms >= 60000) return 'minutes';
    if (ms >= 1000) return 'seconds';
    return 'ms';
  };

  const formatSchedule = (cron) => {
    if (!cron) return 'Not scheduled';
    if (cron.includes('*/')) {
      const interval = cron.split('*/')[1].split(' ')[0];
      return `Every ${interval} min`;
    }
    const parts = cron.split(' ');
    if (parts.length >= 4) {
      const hour = parts[2].padStart(2, '0');
      const min = parts[1].padStart(2, '0');
      return `Daily at ${hour}:${min}`;
    }
    return cron;
  };

  const [scheduleType, setScheduleType] = useState('none');
  const [scheduleInterval, setScheduleInterval] = useState(5);
  const [scheduleTime, setScheduleTime] = useState('00:00');

  const buildCron = () => {
    if (scheduleType === 'none') return '';
    if (scheduleType === 'interval') return `*/${scheduleInterval} * * * *`;
    if (scheduleType === 'daily') return `0 ${scheduleTime.split(':')[1]} ${scheduleTime.split(':')[0]} * * *`;
    return '';
  };

  const parseCronToState = (cron) => {
    if (!cron) { setScheduleType('none'); return; }
    if (cron.includes('*/')) {
      setScheduleType('interval');
      setScheduleInterval(parseInt(cron.split('*/')[1].split(' ')[0]));
    } else if (cron.includes('0 ')) {
      setScheduleType('daily');
      const parts = cron.split(' ');
      setScheduleTime(`${parts[2].padStart(2, '0')}:${parts[1].padStart(2, '0')}`);
    }
  };

  return (
    <div className="flex-col gap-md">
      {activeView === 'list' && (
        <>
          <div className="flex justify-between items-center gap-sm flex-wrap">
            <div style={{ minWidth: 0 }}>
              <h2 className="font-bold" style={{ fontSize: '1.25rem' }}>Sequences</h2>
              <span className="text-muted text-sm">{sequences.length} saved</span>
            </div>
            <button
              className="btn btn-success"
              onClick={() => { resetForm(); setActiveView('create'); }}
            >
              + New sequence
            </button>
          </div>

          {templates.length > 0 && (
            <div className="comp-card">
              <div className="comp-card-header">
                <span className="comp-card-title">⚡ Templates</span>
                <span className="text-xs text-muted">Tap to load &amp; edit</span>
              </div>
              <div className="comp-card-body flex-col gap-sm">
                {templates.map(tpl => (
                  <div
                    key={tpl.id}
                    className="flex items-center gap-sm p-sm flex-wrap"
                    style={{ background: 'var(--panel2)', borderRadius: 8 }}
                  >
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div className="font-medium" style={{ wordBreak: 'break-word' }}>{tpl.name}</div>
                      <div className="text-xs text-muted" style={{ wordBreak: 'break-word' }}>{tpl.description}</div>
                      <div className="text-xs text-muted mt-xs">
                        {tpl.steps.map(s => getStepIcon(s.type)).join(' ')} ({tpl.steps.length} steps)
                      </div>
                    </div>
                    <button
                      className="btn btn-primary btn-sm"
                      onClick={() => loadTemplate(tpl)}
                      style={{ flexShrink: 0 }}
                    >
                      Use template
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {sequences.length === 0 ? (
            <div className="comp-card">
              <div className="comp-card-body">
                <div className="empty-state">
                  <div className="empty-state-icon">📋</div>
                  <div className="empty-state-title">No sequences yet</div>
                  <div className="empty-state-text">Pick a template above or create your own</div>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex-col gap-sm">
              {sequences.map(seq => (
                <div key={seq.id} className="comp-card">
                  <div className="comp-card-body flex-col gap-sm">
                    <div className="flex-1" style={{ minWidth: 0 }}>
                      <div className="font-medium" style={{ wordBreak: 'break-word' }}>{seq.name}</div>
                      <div className="text-sm text-muted">
                        {seq.profile_name || 'Unknown'} • {JSON.parse(seq.steps || '[]').length} steps
                      </div>
                      {seq.schedule_cron && (
                        <div className="text-xs mt-sm" style={{ color: seq.schedule_enabled ? 'var(--green)' : 'var(--muted)' }}>
                          {seq.schedule_enabled ? '🔄' : '⏸'} {formatSchedule(seq.schedule_cron)}
                        </div>
                      )}
                    </div>
                    <div className="flex gap-sm flex-wrap" style={{ marginTop: 'var(--space-xs)' }}>
                      <button className="btn btn-primary" style={{ flex: '1 1 100px' }} onClick={() => runSequence(seq.id)}>▶ Run</button>
                      <button className="btn btn-secondary" onClick={() => editSequenceLoad(seq)} aria-label="Edit">✏️ Edit</button>
                      <button className="btn btn-danger" onClick={() => deleteSequence(seq.id)} aria-label="Delete">🗑</button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {(activeView === 'create' || activeView === 'edit') && (
        <>
          <div className="flex justify-between items-center gap-sm flex-wrap">
            <h2 className="font-bold" style={{ fontSize: '1.25rem', wordBreak: 'break-word' }}>{editSequence ? 'Edit Sequence' : 'New Sequence'}</h2>
            <button className="btn btn-ghost" onClick={resetForm}>← Back to list</button>
          </div>

          <div className="comp-card">
            <div className="comp-card-body flex-col gap-md">
              <div>
                <label className="text-sm text-muted mb-sm" style={{ display: 'block' }}>Name</label>
                <input
                  type="text"
                  className="input"
                  placeholder="My Autoload Sequence"
                  value={sequenceName}
                  onChange={e => setSequenceName(e.target.value)}
                />
              </div>
              <div>
                <label className="text-sm text-muted mb-sm" style={{ display: 'block' }}>
                  Profile {needsProfile ? <span style={{ color: 'var(--red)' }}>· required</span> : <span>· optional</span>}
                </label>
                <select
                  className="select"
                  value={selectedProfile}
                  onChange={e => setSelectedProfile(e.target.value)}
                >
                  <option value="">{profiles.length === 0 ? 'No profiles yet — only download/extract/convert/upload steps available' : 'No profile (host-only steps)'}</option>
                  {profiles.map(p => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          <div className="comp-card">
            <div className="comp-card-header">
              <span className="comp-card-title">⏰ Schedule</span>
            </div>
            <div className="comp-card-body flex-col gap-md">
              <div className="flex gap-sm flex-wrap">
                <button
                  className={`btn btn-sm ${scheduleType === 'none' ? 'btn-primary' : 'btn-ghost'}`}
                  onClick={() => setScheduleType('none')}
                >
                  Off
                </button>
                <button
                  className={`btn btn-sm ${scheduleType === 'interval' ? 'btn-primary' : 'btn-ghost'}`}
                  onClick={() => setScheduleType('interval')}
                >
                  ⏱ Interval
                </button>
                <button
                  className={`btn btn-sm ${scheduleType === 'daily' ? 'btn-primary' : 'btn-ghost'}`}
                  onClick={() => setScheduleType('daily')}
                >
                  📅 Daily
                </button>
              </div>

              {scheduleType === 'interval' && (
                <div className="flex items-center gap-sm">
                  <span className="text-sm text-muted">Every</span>
                  <select
                    className="select"
                    style={{ width: 'auto' }}
                    value={scheduleInterval}
                    onChange={e => setScheduleInterval(parseInt(e.target.value))}
                  >
                    {[5, 10, 15, 20, 30].map(v => (
                      <option key={v} value={v}>{v} min</option>
                    ))}
                  </select>
                </div>
              )}

              {scheduleType === 'daily' && (
                <div className="flex items-center gap-sm">
                  <span className="text-sm text-muted">At</span>
                  <input
                    type="time"
                    className="input"
                    style={{ width: 'auto' }}
                    value={scheduleTime}
                    onChange={e => setScheduleTime(e.target.value)}
                  />
                </div>
              )}

              {scheduleType !== 'none' && (
                <label className="flex items-center gap-sm" style={{ cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={scheduleEnabled}
                    onChange={e => setScheduleEnabled(e.target.checked)}
                  />
                  <span className="text-sm">Enable schedule</span>
                </label>
              )}
            </div>
          </div>

          <div className="comp-card">
            <div className="comp-card-header">
              <span className="comp-card-title">➕ Add Step</span>
            </div>
            <div className="comp-card-body flex-col gap-md">
              <div className="autoload-add-grid">
                <button className="btn btn-secondary" onClick={() => setShowAddStepMenu(showAddStepMenu === 'download' ? null : 'download')}>⬇️ Download</button>
                <button className="btn btn-secondary" onClick={() => setShowAddStepMenu(showAddStepMenu === 'extract' ? null : 'extract')}>📂 Extract</button>
                <button className="btn btn-secondary" onClick={() => setShowAddStepMenu(showAddStepMenu === 'convert' ? null : 'convert')}>🔄 Convert</button>
                <button className="btn btn-secondary" onClick={() => setShowAddStepMenu(showAddStepMenu === 'ftp_upload' ? null : 'ftp_upload')}>⬆️ FTP Upload</button>
                <button className="btn btn-secondary" onClick={() => setShowAddStepMenu(showAddStepMenu === 'wol' ? null : 'wol')}>📡 Wake</button>
                <button className="btn btn-secondary" onClick={() => setShowAddStepMenu(showAddStepMenu === 'check_port' ? null : 'check_port')}>🔌 Port Check</button>
                <button className="btn btn-secondary" onClick={() => setShowAddStepMenu(showAddStepMenu === 'payload' ? null : 'payload')}>📦 Payload</button>
                <button className="btn btn-secondary" onClick={() => setShowAddStepMenu(showAddStepMenu === 'input_script' ? null : 'input_script')}>▶️ Script</button>
                <button className="btn btn-secondary" onClick={() => setShowAddStepMenu(showAddStepMenu === 'rp_session' ? null : 'rp_session')}>🕹️ RP session</button>
                <button className="btn btn-secondary" onClick={() => setShowAddStepMenu(showAddStepMenu === 'klog_read' ? null : 'klog_read')}>📜 Klog</button>
                <button className="btn btn-secondary" onClick={() => setShowAddStepMenu(showAddStepMenu === 'lua_log_read' ? null : 'lua_log_read')}>📝 Lua Log</button>
                <button className="btn btn-secondary" onClick={() => setShowAddStepMenu(showAddStepMenu === 'wait' ? null : 'wait')}>⏱ Wait</button>
              </div>

              {showAddStepMenu === 'payload' && (
                <div className="p-md" style={{ background: 'var(--panel2)', borderRadius: 8 }}>
                  <label className="text-sm text-muted mb-sm" style={{ display: 'block' }}>Select Payload</label>
                  <div className="flex gap-sm flex-wrap">
                    {payloads.length === 0 ? (
                      <span className="text-sm text-muted">No payloads available.</span>
                    ) : (
                      payloads.map(p => (
                        <button
                          key={p.id}
                          className="btn btn-sm btn-ghost"
                          onClick={() => { addStep(p.id); setShowAddStepMenu(null); }}
                        >
                          + {p.name}
                        </button>
                      ))
                    )}
                  </div>
                </div>
              )}

              {showAddStepMenu === 'wol' && (
                <div className="p-md" style={{ background: 'var(--panel2)', borderRadius: 8 }}>
                  <p className="text-sm text-muted mb-sm">
                    Pre-warm Remote Play: wakes the PS5 from standby, logs the user in
                    (dismisses the "Press PS button" picker) and parks the session in the
                    sidecar's warm cache so the next input_script / rp_session step resumes
                    in ~17 ms instead of re-running the full handshake.
                  </p>
                  <p className="text-xs text-muted mb-md">
                    Falls back to plain DDP wake if pre-warm fails (e.g. no RP credentials saved).
                  </p>
                  <button
                    className="btn btn-success"
                    onClick={() => { addWolStep(); setShowAddStepMenu(null); }}
                  >
                    + Add Wake / Pre-warm
                  </button>
                </div>
              )}

              {showAddStepMenu === 'check_port' && (
                <div className="p-md" style={{ background: 'var(--panel2)', borderRadius: 8 }}>
                  <label className="text-sm text-muted mb-sm" style={{ display: 'block' }}>Check Port - repeat steps on failure</label>
                  <div className="flex gap-sm items-center flex-wrap mb-md">
                    <span className="text-sm text-muted">Port:</span>
                    <input
                      type="number"
                      className="input"
                      style={{ width: 80 }}
                      value={targetPort}
                      onChange={e => setTargetPort(e.target.value)}
                    />
                  </div>
                  <div className="flex gap-sm items-center flex-wrap mb-md">
                    <span className="text-sm text-muted">Repeat steps:</span>
                    <input
                      type="number"
                      className="input"
                      style={{ width: 60 }}
                      value={portRetryFrom}
                      onChange={e => setPortRetryFrom(e.target.value)}
                      min={1}
                      placeholder="From"
                    />
                    <span className="text-sm text-muted">to</span>
                    <input
                      type="number"
                      className="input"
                      style={{ width: 60 }}
                      value={portRetryTo}
                      onChange={e => setPortRetryTo(e.target.value)}
                      min={1}
                      placeholder="To"
                    />
                  </div>
                  <button
                    className="btn btn-success"
                    onClick={() => { addCheckPortStep(); setShowAddStepMenu(null); }}
                  >
                    + Add Check Port
                  </button>
                </div>
              )}

              {showAddStepMenu === 'lua_log_read' && (
                <div className="p-md" style={{ background: 'var(--panel2)', borderRadius: 8 }}>
                  <label className="text-sm text-muted mb-sm" style={{ display: 'block' }}>Pattern to match in PS5 output</label>
                  <div className="flex gap-sm items-center flex-wrap mb-md">
                    <input
                      type="text"
                      className="input"
                      style={{ width: 200 }}
                      placeholder="e.g. SUCCESS or ERROR"
                      value={luaLogPattern}
                      onChange={e => setLuaLogPattern(e.target.value)}
                    />
                  </div>
                  <button
                    className="btn btn-success"
                    onClick={() => { addLuaLogReadStep(); setShowAddStepMenu(null); }}
                  >
                    + Add Lua Log Read
                  </button>
                </div>
              )}

              {showAddStepMenu === 'input_script' && (
                <div className="p-md" style={{ background: 'var(--panel2)', borderRadius: 8 }}>
                  <label className="text-sm text-muted mb-sm" style={{ display: 'block' }}>Select Input Script</label>
                  <p className="text-xs text-muted mb-md">
                    Plays back the script through the Remote Play sidecar. The profile must be paired in the Remote Play tab.
                  </p>

                  {builtinInputScripts.length > 0 && (
                    <>
                      <div className="text-xs text-muted mb-sm" style={{ textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                        🧩 Built-in
                      </div>
                      <div className="flex-col gap-sm mb-md">
                        {builtinInputScripts.map(script => (
                          <button
                            key={script.id}
                            className="btn btn-ghost text-left"
                            onClick={() => { addInputScriptStep(script.id); setShowAddStepMenu(null); }}
                          >
                            <div className="font-medium">
                              <span className="badge badge-info" style={{ marginRight: 8, fontSize: '0.65rem' }}>BUILT-IN</span>
                              {script.name}
                            </div>
                            {script.description && (
                              <div className="text-xs text-muted truncate">{script.description}</div>
                            )}
                          </button>
                        ))}
                      </div>
                    </>
                  )}

                  <div className="text-xs text-muted mb-sm" style={{ textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    💾 Saved
                  </div>
                  {inputScripts.length === 0 ? (
                    <p className="text-sm text-muted">No saved input scripts. Create them in PS5 Remote.</p>
                  ) : (
                    <div className="flex-col gap-sm">
                      {inputScripts.map(script => (
                        <button
                          key={script.id}
                          className="btn btn-ghost text-left"
                          onClick={() => { addInputScriptStep(script.id); setShowAddStepMenu(null); }}
                        >
                          <div className="font-medium">{script.name}</div>
                          <div className="text-xs text-muted truncate">{script.script.substring(0, 50)}...</div>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {showAddStepMenu === 'klog_read' && (
                <div className="p-md" style={{ background: 'var(--panel2)', borderRadius: 8 }}>
                  <label className="text-sm text-muted mb-sm" style={{ display: 'block' }}>Match Pattern</label>
                  <div className="flex gap-sm items-center flex-wrap mb-md">
                    <input
                      type="text"
                      className="input"
                      style={{ width: 150 }}
                      placeholder="e.g. SUCCESS"
                      value={klogPattern}
                      onChange={e => setKlogPattern(e.target.value)}
                    />
                  </div>
                  <div className="flex gap-sm items-center flex-wrap mb-md">
                    <span className="text-sm text-muted">If found:</span>
                    <button
                      className={`btn btn-sm ${klogSuccessMode ? 'btn-success' : 'btn-ghost'}`}
                      onClick={() => setKlogSuccessMode(true)}
                    >
                      ✓ Success
                    </button>
                    <button
                      className={`btn btn-sm ${!klogSuccessMode ? 'btn-danger' : 'btn-ghost'}`}
                      onClick={() => setKlogSuccessMode(false)}
                    >
                      ✗ Failure
                    </button>
                  </div>
                  <button
                    className="btn btn-success"
                    onClick={() => { addKlogReadStep(); setShowAddStepMenu(null); }}
                  >
                    + Add Klog Read
                  </button>
                </div>
              )}

              {showAddStepMenu === 'rp_session' && (
                <div className="p-md flex-col gap-sm" style={{ background: 'var(--panel2)', borderRadius: 8 }}>
                  <p className="text-sm text-muted">
                    Opens (or closes) a Remote Play session for the selected profile so subsequent
                    input scripts execute against a warm session. Pair the PS5 in P5 Control first.
                  </p>
                  <div className="flex gap-sm">
                    <button className="btn btn-success"
                      onClick={() => { addRpSessionStep('start'); setShowAddStepMenu(null); }}>
                      ▶ Add Start session
                    </button>
                    <button className="btn btn-danger"
                      onClick={() => { addRpSessionStep('stop'); setShowAddStepMenu(null); }}>
                      ⏹ Add Stop session
                    </button>
                  </div>
                </div>
              )}

              {showAddStepMenu === 'wait' && (
                <div className="p-md" style={{ background: 'var(--panel2)', borderRadius: 8 }}>
                  <label className="text-sm text-muted mb-sm" style={{ display: 'block' }}>Wait Duration</label>
                  <div className="flex gap-sm items-center flex-wrap">
                    <input
                      type="number"
                      className="input"
                      style={{ width: 80 }}
                      value={waitTime}
                      onChange={e => setWaitTime(parseFloat(e.target.value) || 0)}
                      min={0.1}
                      step={0.5}
                    />
                    <select
                      className="select"
                      style={{ width: 'auto' }}
                      value={waitUnit}
                      onChange={e => setWaitUnit(e.target.value)}
                    >
                      <option value="seconds">sec</option>
                      <option value="minutes">min</option>
                      <option value="hours">hour</option>
                    </select>
                    <button
                      className="btn btn-success"
                      onClick={() => { addWaitStep(); setShowAddStepMenu(null); }}
                    >
                      + Add Wait
                    </button>
                  </div>
                </div>
              )}

              {showAddStepMenu === 'download' && (
                <div className="p-md flex-col gap-sm" style={{ background: 'var(--panel2)', borderRadius: 8 }}>
                  <label className="text-sm text-muted" style={{ display: 'block' }}>URL (http/https/magnet)</label>
                  <input className="input" placeholder="https://example.com/file.zip"
                    value={dlUrl} onChange={e => setDlUrl(e.target.value)} />
                  <div className="grid-2 gap-sm">
                    <div>
                      <label className="text-sm text-muted" style={{ display: 'block' }}>Filename (optional)</label>
                      <input className="input" placeholder="(auto from URL)"
                        value={dlFilename} onChange={e => setDlFilename(e.target.value)} />
                    </div>
                    <div>
                      <label className="text-sm text-muted" style={{ display: 'block' }}>Destination folder</label>
                      <input className="input" placeholder="/data/mkpfs"
                        value={dlDestPath} onChange={e => setDlDestPath(e.target.value)} />
                    </div>
                  </div>
                  <button className="btn btn-success" disabled={!dlUrl.trim()}
                    onClick={() => { addDownloadStep(); setShowAddStepMenu(null); }}>
                    + Add Download
                  </button>
                </div>
              )}

              {showAddStepMenu === 'extract' && (
                <div className="p-md flex-col gap-sm" style={{ background: 'var(--panel2)', borderRadius: 8 }}>
                  <label className="text-sm text-muted" style={{ display: 'block' }}>Archive path (local)</label>
                  <input className="input" placeholder="/data/mkpfs/archive.zip"
                    value={extractLocalPath} onChange={e => setExtractLocalPath(e.target.value)} />
                  <div className="grid-2 gap-sm">
                    <div>
                      <label className="text-sm text-muted" style={{ display: 'block' }}>Extract to</label>
                      <input className="input" placeholder="/data/mkpfs"
                        value={extractDestPath} onChange={e => setExtractDestPath(e.target.value)} />
                    </div>
                    <div>
                      <label className="text-sm text-muted" style={{ display: 'block' }}>Password (optional)</label>
                      <input type="password" className="input"
                        value={extractPwd} onChange={e => setExtractPwd(e.target.value)} />
                    </div>
                  </div>
                  <label className="flex items-center gap-sm" style={{ cursor: 'pointer' }}>
                    <input type="checkbox" checked={extractDeleteAfter}
                      onChange={e => setExtractDeleteAfter(e.target.checked)} />
                    <span className="text-sm">Delete archive after extract</span>
                  </label>
                  <button className="btn btn-success" disabled={!extractLocalPath.trim()}
                    onClick={() => { addExtractStep(); setShowAddStepMenu(null); }}>
                    + Add Extract
                  </button>
                </div>
              )}

              {showAddStepMenu === 'convert' && (
                <div className="p-md flex-col gap-sm" style={{ background: 'var(--panel2)', borderRadius: 8 }}>
                  <label className="text-sm text-muted" style={{ display: 'block' }}>Mode</label>
                  <div className="flex gap-sm">
                    <button className={`btn btn-sm ${convMode === 'pack-file' ? 'btn-primary' : 'btn-ghost'}`}
                      onClick={() => setConvMode('pack-file')}>File → ffpfsc</button>
                    <button className={`btn btn-sm ${convMode === 'pack-folder' ? 'btn-primary' : 'btn-ghost'}`}
                      onClick={() => setConvMode('pack-folder')}>Folder → ffpfsc</button>
                  </div>
                  <label className="text-sm text-muted" style={{ display: 'block' }}>Source path</label>
                  <input className="input" placeholder="/data/mkpfs/game.exfat or /data/mkpfs/game/"
                    value={convSourcePath} onChange={e => setConvSourcePath(e.target.value)} />
                  <label className="text-sm text-muted" style={{ display: 'block' }}>Output filename (optional)</label>
                  <input className="input" placeholder="game.ffpfsc"
                    value={convOutputName} onChange={e => setConvOutputName(e.target.value)} />
                  <button className="btn btn-success" disabled={!convSourcePath.trim()}
                    onClick={() => { addConvertStep(); setShowAddStepMenu(null); }}>
                    + Add Convert
                  </button>
                </div>
              )}

              {showAddStepMenu === 'ftp_upload' && (
                <div className="p-md flex-col gap-sm" style={{ background: 'var(--panel2)', borderRadius: 8 }}>
                  <p className="text-sm text-muted">Uploads to the IP from the sequence's profile.</p>
                  <label className="text-sm text-muted" style={{ display: 'block' }}>Local file path</label>
                  <input className="input" placeholder="/data/mkpfs/file.ffpfsc"
                    value={ftpLocalPath} onChange={e => setFtpLocalPath(e.target.value)} />
                  <label className="text-sm text-muted" style={{ display: 'block' }}>Remote destination directory</label>
                  <input className="input" placeholder="/data/homebrew"
                    value={ftpDestPath} onChange={e => setFtpDestPath(e.target.value)} />
                  <button className="btn btn-success" disabled={!ftpLocalPath.trim()}
                    onClick={() => { addFtpUploadStep(); setShowAddStepMenu(null); }}>
                    + Add FTP Upload
                  </button>
                </div>
              )}
            </div>
          </div>

          <div className="comp-card">
            <div className="comp-card-header">
              <span className="comp-card-title">📋 Steps ({steps.length})</span>
            </div>
            <div className="comp-card-body">
              {steps.length === 0 ? (
                <div className="empty-state" style={{ padding: 'var(--space-lg)' }}>
                  <div className="empty-state-icon">➕</div>
                  <div className="empty-state-title">No steps yet</div>
                  <div className="empty-state-text">Add steps above to build your sequence</div>
                </div>
              ) : (
                <div className="flex-col gap-sm">
                  {steps.map((step, index) => {
                    const editable = ['wait','input_script','payload','check_port','rp_session','download','extract','convert','ftp_upload'].includes(step.type);
                    return (
                      <div key={index} className="step-card">
                        <div className="step-card-head">
                          <span className="badge" style={{ background: 'var(--panel)', minWidth: 28, textAlign: 'center' }}>
                            {index + 1}
                          </span>
                          <span style={{ fontSize: '1.3rem' }}>{getStepIcon(step.type)}</span>
                          <span className="step-title">{step.name || step.type}</span>
                          <div className="step-actions">
                            <button
                              className="btn btn-sm btn-ghost"
                              onClick={() => moveStep(index, -1)}
                              disabled={index === 0}
                              aria-label="Move up"
                            >↑</button>
                            <button
                              className="btn btn-sm btn-ghost"
                              onClick={() => moveStep(index, 1)}
                              disabled={index === steps.length - 1}
                              aria-label="Move down"
                            >↓</button>
                            <button
                              className="btn btn-sm btn-danger"
                              onClick={() => removeStep(index)}
                              aria-label="Remove step"
                            >✕</button>
                          </div>
                        </div>
                        {editable && (
                          <div className="step-card-body">
                            {step.type === 'wait' && (
                              <>
                                <label className="field-label">Wait</label>
                                <input
                                  type="number"
                                  className="input"
                                  value={getWaitDisplayValue(step.duration)}
                                  onChange={e => updateWaitStep(index, humanToMs(parseFloat(e.target.value) || 0, getWaitDisplayUnit(step.duration)))}
                                  min={0.1}
                                  step={0.5}
                                />
                                <span className="text-sm text-muted">{getWaitDisplayUnit(step.duration)}</span>
                              </>
                            )}
                            {step.type === 'input_script' && (
                              <>
                                <label className="field-label">Input script</label>
                                <select
                                  className="select"
                                  value={step.scriptId != null ? String(step.scriptId) : ''}
                                  onChange={e => {
                                    const v = e.target.value;
                                    if (!v) { patchStep(index, { scriptId: null }); return; }
                                    // Keep built-in ids as strings; coerce numeric user-script ids to int
                                    // so the value type matches the original /api/input-scripts payload.
                                    const id = v.startsWith('builtin:') ? v : (parseInt(v) || null);
                                    patchStep(index, { scriptId: id });
                                  }}
                                >
                                  <option value="">— pick a script —</option>
                                  {builtinInputScripts.length > 0 && (
                                    <optgroup label="🧩 Built-in">
                                      {builtinInputScripts.map(s => (
                                        <option key={s.id} value={s.id}>{s.name}</option>
                                      ))}
                                    </optgroup>
                                  )}
                                  {inputScripts.length > 0 && (
                                    <optgroup label="💾 Saved">
                                      {inputScripts.map(s => (
                                        <option key={s.id} value={s.id}>{s.name}</option>
                                      ))}
                                    </optgroup>
                                  )}
                                </select>
                              </>
                            )}
                            {step.type === 'payload' && (
                              <>
                                <label className="field-label">Payload (by id)</label>
                                <select
                                  className="select"
                                  value={step.payloadId || ''}
                                  onChange={e => {
                                    const v = e.target.value;
                                    patchStep(index, { payloadId: v ? parseInt(v) : null, payloadName: v ? null : step.payloadName });
                                  }}
                                >
                                  <option value="">— pick a payload —</option>
                                  {(payloads || []).map(p => (
                                    <option key={p.id} value={p.id}>{p.filename || p.name}</option>
                                  ))}
                                </select>
                                <label className="field-label">…or by name</label>
                                <input
                                  className="input"
                                  placeholder="e.g. p2jb.lua"
                                  value={step.payloadName || ''}
                                  onChange={e => patchStep(index, { payloadName: e.target.value, payloadId: null })}
                                />
                              </>
                            )}
                            {step.type === 'check_port' && (
                              <>
                                <label className="field-label">Port</label>
                                <input
                                  type="number"
                                  className="input"
                                  value={step.port || ''}
                                  onChange={e => patchStep(index, { port: parseInt(e.target.value) || 0 })}
                                  min={1}
                                  max={65535}
                                />
                                <label className="field-label">Retry from step</label>
                                <input
                                  type="number"
                                  className="input"
                                  value={step.retryFromStep ?? ''}
                                  onChange={e => patchStep(index, { retryFromStep: e.target.value === '' ? null : parseInt(e.target.value) })}
                                  placeholder="optional"
                                />
                                <label className="field-label">Retry to step</label>
                                <input
                                  type="number"
                                  className="input"
                                  value={step.retryToStep ?? ''}
                                  onChange={e => patchStep(index, { retryToStep: e.target.value === '' ? null : parseInt(e.target.value) })}
                                  placeholder="optional"
                                />
                              </>
                            )}
                            {step.type === 'rp_session' && (
                              <>
                                <label className="field-label">Action</label>
                                <select
                                  className="select"
                                  value={step.action || 'start'}
                                  onChange={e => patchStep(index, { action: e.target.value })}
                                >
                                  <option value="start">▶ Start session</option>
                                  <option value="stop">⏹ Stop session</option>
                                </select>
                              </>
                            )}
                            {step.type === 'wol' && (
                              <>
                                <label className="field-label" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                  <input
                                    type="checkbox"
                                    checked={!!step.keep_session}
                                    onChange={e => patchStep(index, { keep_session: e.target.checked })}
                                  />
                                  <span>Promote warm cache to a live RP session</span>
                                </label>
                                <div className="text-xs text-muted" style={{ marginTop: 4 }}>
                                  Pre-warm already holds the PS5 awake via the sidecar warm cache, so
                                  this is only needed if a downstream tool (e.g. another script poking
                                  the sidecar directly) expects a session in the live SESSIONS pool
                                  rather than PAUSED_SESSIONS. Leave off for most sequences.
                                </div>
                              </>
                            )}
                            {step.type === 'download' && (
                              <>
                                <label className="field-label">URL</label>
                                <input
                                  className="input"
                                  placeholder="https://…"
                                  value={step.url || ''}
                                  onChange={e => patchStep(index, { url: e.target.value })}
                                />
                              </>
                            )}
                            {step.type === 'extract' && (
                              <>
                                <label className="field-label">Archive path</label>
                                <input
                                  className="input"
                                  placeholder="/data/mkpfs/archive.zip"
                                  value={step.local_path || ''}
                                  onChange={e => patchStep(index, { local_path: e.target.value })}
                                />
                              </>
                            )}
                            {step.type === 'convert' && (
                              <>
                                <label className="field-label">Source path</label>
                                <input
                                  className="input"
                                  placeholder="/data/mkpfs/game.exfat"
                                  value={step.source_path || ''}
                                  onChange={e => patchStep(index, { source_path: e.target.value })}
                                />
                              </>
                            )}
                            {step.type === 'ftp_upload' && (
                              <>
                                <label className="field-label">Local file</label>
                                <input
                                  className="input"
                                  placeholder="/data/mkpfs/file.ffpfsc"
                                  value={step.local_path || ''}
                                  onChange={e => patchStep(index, { local_path: e.target.value })}
                                />
                                <label className="field-label">PS5 destination</label>
                                <input
                                  className="input"
                                  placeholder="/data/homebrew"
                                  value={step.dest_path || ''}
                                  onChange={e => patchStep(index, { dest_path: e.target.value })}
                                />
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              <button
                className={`btn btn-block mt-md ${(!sequenceName || steps.length === 0 || (needsProfile && !selectedProfile)) ? 'btn-ghost' : 'btn-success'}`}
                onClick={editSequence ? updateSequence : saveSequence}
                disabled={!sequenceName || steps.length === 0 || (needsProfile && !selectedProfile)}
                style={{ minHeight: 52, fontSize: '1rem', fontWeight: 600 }}
              >
                {editSequence ? '💾 Update Sequence' : '💾 Save Sequence'}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export default AutoloadBuilder;