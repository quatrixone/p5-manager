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
  const [chiakiCommand, setChiakiCommand] = useState('');
  const [inputScripts, setInputScripts] = useState([]);

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
      const res = await fetch(`${API}/input-scripts`);
      const data = await res.json();
      setInputScripts(data);
    } catch (err) {
      console.error('Failed to fetch input scripts:', err);
    }
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
    setSteps([...steps, { type: 'wol', name: 'Wake on LAN' }]);
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
    const script = inputScripts.find(s => s.id === scriptId);
    if (!script) return;
    setSteps([...steps, {
      type: 'input_script',
      scriptId: script.id,
      scriptName: script.name,
      script: script.script,
      name: `Input: ${script.name}`
    }]);
  };

  const addChiakiCommandStep = () => {
    if (!chiakiCommand.trim()) return;
    setSteps([...steps, {
      type: 'chiaki_cmd',
      command: chiakiCommand,
      name: `Chiaki CLI: ${chiakiCommand}`
    }]);
  };

  const addWaitStep = () => {
    const ms = humanToMs(waitTime, waitUnit);
    if (ms <= 0) return;
    setSteps([...steps, { type: 'wait', duration: ms, name: `Wait ${waitTime} ${waitUnit}` }]);
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

  const needsProfile = steps.some(s => ['wol', 'payload', 'check_port', 'input_script', 'ftp_upload'].includes(s.type));

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
          <div className="flex justify-between items-center">
            <div>
              <h2 className="font-bold" style={{ fontSize: '1.25rem' }}>Sequences</h2>
              <span className="text-muted text-sm">{sequences.length} saved</span>
            </div>
            <button
              className="btn btn-success"
              onClick={() => { resetForm(); setActiveView('create'); }}
            >
              + New
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
                  <div key={tpl.id} className="flex justify-between items-start gap-md p-sm"
                    style={{ background: 'var(--panel2)', borderRadius: 8 }}>
                    <div className="flex-1" style={{ minWidth: 0 }}>
                      <div className="font-medium">{tpl.name}</div>
                      <div className="text-xs text-muted">{tpl.description}</div>
                      <div className="text-xs text-muted mt-xs">
                        {tpl.steps.map(s => getStepIcon(s.type)).join(' ')} ({tpl.steps.length} steps)
                      </div>
                    </div>
                    <button className="btn btn-sm btn-primary" onClick={() => loadTemplate(tpl)}>Use</button>
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
                  <div className="comp-card-body">
                    <div className="flex justify-between items-start gap-md">
                      <div className="flex-1">
                        <div className="font-medium">{seq.name}</div>
                        <div className="text-sm text-muted">
                          {seq.profile_name || 'Unknown'} • {JSON.parse(seq.steps || '[]').length} steps
                        </div>
                        {seq.schedule_cron && (
                          <div className="text-xs mt-sm" style={{ color: seq.schedule_enabled ? 'var(--green)' : 'var(--muted)' }}>
                            {seq.schedule_enabled ? '🔄' : '⏸'} {formatSchedule(seq.schedule_cron)}
                          </div>
                        )}
                      </div>
                      <div className="flex gap-xs">
                        <button className="btn btn-sm btn-primary" onClick={() => runSequence(seq.id)}>▶ Run</button>
                        <button className="btn btn-sm btn-secondary" onClick={() => editSequenceLoad(seq)}>✏️</button>
                        <button className="btn btn-sm btn-danger" onClick={() => deleteSequence(seq.id)}>✕</button>
                      </div>
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
          <div className="flex justify-between items-center">
            <h2 className="font-bold" style={{ fontSize: '1.25rem' }}>{editSequence ? 'Edit Sequence' : 'New Sequence'}</h2>
            <button className="btn btn-ghost" onClick={resetForm}>← Back</button>
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
              <div className="flex gap-sm flex-wrap">
                <button className="btn btn-sm btn-secondary" onClick={() => setShowAddStepMenu('download')}>⬇️ Download</button>
                <button className="btn btn-sm btn-secondary" onClick={() => setShowAddStepMenu('extract')}>📂 Extract</button>
                <button className="btn btn-sm btn-secondary" onClick={() => setShowAddStepMenu('convert')}>🔄 Convert</button>
                <button className="btn btn-sm btn-secondary" onClick={() => setShowAddStepMenu('ftp_upload')}>⬆️ FTP Upload</button>
                <button className="btn btn-sm btn-secondary" onClick={() => setShowAddStepMenu('wol')}>📡 Wake</button>
                <button className="btn btn-sm btn-secondary" onClick={() => setShowAddStepMenu('check_port')}>🔌 Port Check</button>
                <button className="btn btn-sm btn-secondary" onClick={() => setShowAddStepMenu('payload')}>📦 Payload</button>
                <button className="btn btn-sm btn-secondary" onClick={() => setShowAddStepMenu('input_script')}>▶️ Script</button>
                <button className="btn btn-sm btn-secondary" onClick={() => setShowAddStepMenu('klog_read')}>📜 Klog</button>
                <button className="btn btn-sm btn-secondary" onClick={() => setShowAddStepMenu('lua_log_read')}>📝 Lua Log</button>
                <button className="btn btn-sm btn-secondary" onClick={() => setShowAddStepMenu('wait')}>⏱ Wait</button>
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
                  <p className="text-sm text-muted mb-md">Wake PS5 using profile's MAC address</p>
                  <button
                    className="btn btn-success"
                    onClick={() => { addWolStep(); setShowAddStepMenu(null); }}
                  >
                    + Add Wake on LAN
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
                    Plays back the script through Remote Play (chiaki sidecar). The profile must be paired in the Remote Play tab.
                  </p>
                  {inputScripts.length === 0 ? (
                    <p className="text-sm text-muted">No input scripts saved. Create them in PS5 Remote.</p>
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
                  {steps.map((step, index) => (
                    <div key={index} className="flex items-center gap-sm p-sm" style={{ background: 'var(--panel2)', borderRadius: 6 }}>
                      <span className="badge" style={{ background: 'var(--panel)', minWidth: 28, textAlign: 'center' }}>
                        {index + 1}
                      </span>
                      <span style={{ fontSize: '1.2rem', width: 24, textAlign: 'center' }}>{getStepIcon(step.type)}</span>
                      {step.type === 'wait' ? (
                        <div className="flex-1 flex items-center gap-sm">
                          <input
                            type="number"
                            className="input"
                            style={{ width: 80 }}
                            value={getWaitDisplayValue(step.duration)}
                            onChange={e => updateWaitStep(index, humanToMs(parseFloat(e.target.value) || 0, getWaitDisplayUnit(step.duration)))}
                            min={0.1}
                            step={0.5}
                          />
                          <span className="text-sm text-muted">{getWaitDisplayUnit(step.duration)}</span>
                        </div>
                      ) : (
                        <span className="flex-1 text-sm truncate">{step.name}</span>
                      )}
                      <button
                        className="btn btn-sm btn-ghost"
                        onClick={() => moveStep(index, -1)}
                        disabled={index === 0}
                      >↑</button>
                      <button
                        className="btn btn-sm btn-ghost"
                        onClick={() => moveStep(index, 1)}
                        disabled={index === steps.length - 1}
                      >↓</button>
                      <button
                        className="btn btn-sm btn-danger"
                        onClick={() => removeStep(index)}
                      >✕</button>
                    </div>
                  ))}
                </div>
              )}

              <button
                className={`btn btn-block mt-md ${(!sequenceName || steps.length === 0 || (needsProfile && !selectedProfile)) ? 'btn-ghost' : 'btn-success'}`}
                onClick={editSequence ? updateSequence : saveSequence}
                disabled={!sequenceName || steps.length === 0 || (needsProfile && !selectedProfile)}
              >
                {editSequence ? 'Update Sequence' : 'Save Sequence'}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export default AutoloadBuilder;