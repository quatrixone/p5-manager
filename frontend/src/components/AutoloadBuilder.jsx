import { useState, useEffect } from 'react';

const API = '/api';

function AutoloadBuilder({ profiles, payloads, onNotification }) {
  const [sequences, setSequences] = useState([]);
  const [activeView, setActiveView] = useState('list');
  const [editSequence, setEditSequence] = useState(null);
  const [sequenceName, setSequenceName] = useState('');
  const [selectedProfile, setSelectedProfile] = useState('');
  const [steps, setSteps] = useState([]);
  const [waitTime, setWaitTime] = useState(1);
  const [waitUnit, setWaitUnit] = useState('seconds');
  const [scheduleCron, setScheduleCron] = useState('');
  const [scheduleEnabled, setScheduleEnabled] = useState(false);

  const fetchSequences = async () => {
    try {
      const res = await fetch(`${API}/sequences`);
      const data = await res.json();
      setSequences(data);
    } catch (err) {
      console.error('Failed to fetch sequences:', err);
    }
  };

  useEffect(() => {
    fetchSequences();
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

  const addWaitStep = () => {
    const ms = humanToMs(waitTime, waitUnit);
    if (ms <= 0) return;
    setSteps([...steps, { type: 'wait', duration: ms, name: `Wait ${waitTime} ${waitUnit}` }]);
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

  const saveSequence = async () => {
    if (!selectedProfile || !sequenceName || steps.length === 0) {
      onNotification('Fill all fields and add steps', 'error');
      return;
    }
    try {
      const res = await fetch(`${API}/sequences`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          profileId: selectedProfile,
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
    if (!editSequence || !selectedProfile || !sequenceName || steps.length === 0) {
      onNotification('Fill all fields and add steps', 'error');
      return;
    }
    try {
      const res = await fetch(`${API}/sequences/${editSequence.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: sequenceName,
          steps,
          profileId: selectedProfile,
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
      return `Every ${interval} minutes`;
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      {activeView === 'list' && (
        <>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h2 style={{ fontSize: '1rem' }}>Saved Sequences ({sequences.length})</h2>
            <button
              onClick={() => { resetForm(); setActiveView('create'); }}
              style={{ padding: '0.5rem 1rem', background: '#27ae60', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: '0.9rem' }}
            >
              + New Sequence
            </button>
          </div>

          {sequences.length === 0 ? (
            <p style={{ color: '#888', textAlign: 'center', padding: '2rem' }}>No sequences yet. Create one!</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {sequences.map(seq => (
                <div key={seq.id} style={{ padding: '1rem', background: '#16213e', borderRadius: 8 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '0.5rem' }}>
                    <div>
                      <div style={{ fontWeight: 500 }}>{seq.name}</div>
                      <div style={{ fontSize: '0.8rem', color: '#aaa' }}>
                        {seq.profile_name || 'Unknown profile'} • {JSON.parse(seq.steps || '[]').length} steps
                      </div>
                      {seq.schedule_cron && (
                        <div style={{ fontSize: '0.75rem', color: seq.schedule_enabled ? '#27ae60' : '#888', marginTop: '0.25rem' }}>
                          {seq.schedule_enabled ? '🔄' : '⏸'} {formatSchedule(seq.schedule_cron)}
                        </div>
                      )}
                    </div>
                    <div style={{ display: 'flex', gap: '0.5rem' }}>
                      <button onClick={() => runSequence(seq.id)} style={{ padding: '0.4rem 0.75rem', background: '#27ae60', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: '0.8rem' }}>
                        Run
                      </button>
                      <button onClick={() => editSequenceLoad(seq)} style={{ padding: '0.4rem 0.75rem', background: '#3498db', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: '0.8rem' }}>
                        Edit
                      </button>
                      <button onClick={() => deleteSequence(seq.id)} style={{ padding: '0.4rem 0.75rem', background: '#e74c3c', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: '0.8rem' }}>
                        Delete
                      </button>
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
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h2 style={{ fontSize: '1rem' }}>{editSequence ? 'Edit Sequence' : 'New Sequence'}</h2>
            <button onClick={resetForm} style={{ padding: '0.4rem 0.75rem', background: '#555', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer' }}>
              ← Back
            </button>
          </div>

          <section style={{ background: '#16213e', padding: '1rem', borderRadius: 12 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginBottom: '1rem' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                <label style={{ fontSize: '0.85rem', color: '#aaa' }}>Sequence Name</label>
                <input
                  type="text"
                  placeholder="My Autoload"
                  value={sequenceName}
                  onChange={e => setSequenceName(e.target.value)}
                  style={{ padding: '0.75rem', borderRadius: 6, border: '1px solid #0f3460', background: '#1a1a2e', color: '#fff', fontSize: '1rem' }}
                />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                <label style={{ fontSize: '0.85rem', color: '#aaa' }}>Target Profile</label>
                <select
                  value={selectedProfile}
                  onChange={e => setSelectedProfile(e.target.value)}
                  style={{ padding: '0.75rem', borderRadius: 6, background: '#1a1a2e', color: '#fff', border: '1px solid #0f3460', fontSize: '1rem' }}
                >
                  <option value="">Select...</option>
                  {profiles.map(p => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </div>
            </div>

            {/* Schedule */}
            <div style={{ marginBottom: '1rem', padding: '1rem', background: '#0f3460', borderRadius: 8 }}>
              <label style={{ fontSize: '0.85rem', color: '#aaa', display: 'block', marginBottom: '0.5rem' }}>Schedule (optional)</label>
              <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.75rem' }}>
                <button
                  onClick={() => setScheduleType('none')}
                  style={{ padding: '0.5rem 1rem', background: scheduleType === 'none' ? '#27ae60' : '#1a1a2e', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: '0.85rem' }}
                >
                  Off
                </button>
                <button
                  onClick={() => setScheduleType('interval')}
                  style={{ padding: '0.5rem 1rem', background: scheduleType === 'interval' ? '#27ae60' : '#1a1a2e', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: '0.85rem' }}
                >
                  Interval
                </button>
                <button
                  onClick={() => setScheduleType('daily')}
                  style={{ padding: '0.5rem 1rem', background: scheduleType === 'daily' ? '#27ae60' : '#1a1a2e', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: '0.85rem' }}
                >
                  Daily
                </button>
              </div>

              {scheduleType === 'interval' && (
                <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
                  <span style={{ color: '#aaa', fontSize: '0.85rem' }}>Every</span>
                  <select
                    value={scheduleInterval}
                    onChange={e => setScheduleInterval(parseInt(e.target.value))}
                    style={{ padding: '0.5rem', borderRadius: 6, background: '#1a1a2e', color: '#fff', border: '1px solid #0f3460', fontSize: '0.85rem' }}
                  >
                    {[5, 10, 15, 20, 30].map(v => (
                      <option key={v} value={v}>{v} min</option>
                    ))}
                  </select>
                </div>
              )}

              {scheduleType === 'daily' && (
                <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                  <span style={{ color: '#aaa', fontSize: '0.85rem' }}>At</span>
                  <input
                    type="time"
                    value={scheduleTime}
                    onChange={e => setScheduleTime(e.target.value)}
                    style={{ padding: '0.5rem', borderRadius: 6, background: '#1a1a2e', color: '#fff', border: '1px solid #0f3460', fontSize: '0.85rem' }}
                  />
                </div>
              )}

              {scheduleType !== 'none' && (
                <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: '#aaa', fontSize: '0.85rem', cursor: 'pointer', marginTop: '0.75rem' }}>
                  <input
                    type="checkbox"
                    checked={scheduleEnabled}
                    onChange={e => setScheduleEnabled(e.target.checked)}
                  />
                  Enable schedule
                </label>
              )}
            </div>

            {/* Add Wait Time */}
            <div style={{ marginBottom: '1rem', padding: '1rem', background: '#0f3460', borderRadius: 8 }}>
              <label style={{ fontSize: '0.85rem', color: '#aaa', display: 'block', marginBottom: '0.5rem' }}>Add Wait Time</label>
              <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
                <input
                  type="number"
                  value={waitTime}
                  onChange={e => setWaitTime(parseFloat(e.target.value) || 0)}
                  min={0.1}
                  step={0.5}
                  style={{ padding: '0.5rem', borderRadius: 6, border: '1px solid #0f3460', background: '#1a1a2e', color: '#fff', fontSize: '0.9rem', width: 80 }}
                />
                <select
                  value={waitUnit}
                  onChange={e => setWaitUnit(e.target.value)}
                  style={{ padding: '0.5rem', borderRadius: 6, background: '#1a1a2e', color: '#fff', border: '1px solid #0f3460', fontSize: '0.85rem' }}
                >
                  <option value="seconds">sec</option>
                  <option value="minutes">min</option>
                  <option value="hours">hour</option>
                </select>
                <div style={{ display: 'flex', gap: '0.25rem' }}>
                  {waitUnit === 'seconds' && [1, 2, 5, 10].map(s => (
                    <button
                      key={s}
                      onClick={() => { setWaitTime(s); setWaitUnit('seconds'); }}
                      style={{ padding: '0.4rem 0.6rem', background: waitTime === s && waitUnit === 'seconds' ? '#27ae60' : '#1a1a2e', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: '0.75rem' }}
                    >
                      {s}s
                    </button>
                  ))}
                  {waitUnit === 'minutes' && [1, 2, 5, 10].map(m => (
                    <button
                      key={m}
                      onClick={() => { setWaitTime(m); setWaitUnit('minutes'); }}
                      style={{ padding: '0.4rem 0.6rem', background: waitTime === m && waitUnit === 'minutes' ? '#27ae60' : '#1a1a2e', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: '0.75rem' }}
                    >
                      {m}m
                    </button>
                  ))}
                  {waitUnit === 'hours' && [0.5, 1, 2, 5].map(h => (
                    <button
                      key={h}
                      onClick={() => { setWaitTime(h); setWaitUnit('hours'); }}
                      style={{ padding: '0.4rem 0.6rem', background: waitTime === h && waitUnit === 'hours' ? '#27ae60' : '#1a1a2e', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: '0.75rem' }}
                    >
                      {h}h
                    </button>
                  ))}
                </div>
                <button
                  onClick={addWaitStep}
                  style={{ padding: '0.5rem 1rem', background: '#8e44ad', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: '0.85rem' }}
                >
                  + Add Wait
                </button>
              </div>
            </div>

            {/* Add Payloads */}
            <div>
              <label style={{ fontSize: '0.85rem', color: '#aaa', display: 'block', marginBottom: '0.5rem' }}>Add Payload</label>
              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                {payloads.length === 0 ? (
                  <span style={{ color: '#888', fontSize: '0.85rem' }}>No payloads available.</span>
                ) : (
                  payloads.map(p => (
                    <button
                      key={p.id}
                      onClick={() => addStep(p.id)}
                      style={{ padding: '0.5rem 0.75rem', background: '#0f3460', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: '0.85rem', minHeight: 36 }}
                    >
                      + {p.name}
                    </button>
                  ))
                )}
              </div>
            </div>
          </section>

          <section style={{ background: '#16213e', padding: '1rem', borderRadius: 12 }}>
            <h2 style={{ fontSize: '1rem', marginBottom: '1rem' }}>Sequence ({steps.length})</h2>

            {steps.length === 0 ? (
              <p style={{ color: '#888', textAlign: 'center', padding: '1.5rem' }}>Add payloads or wait times</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                {steps.map((step, index) => (
                  <div key={index} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.75rem', background: step.type === 'wait' ? '#2c2c54' : '#0f3460', borderRadius: 6, borderLeft: step.type === 'wait' ? '3px solid #8e44ad' : '3px solid #3498db' }}>
                    <span style={{ width: 28, height: 28, background: step.type === 'wait' ? '#8e44ad' : '#16213e', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 600, fontSize: '0.8rem', flexShrink: 0 }}>
                      {index + 1}
                    </span>
                    <span style={{ fontSize: '1.2rem', width: 24, textAlign: 'center' }}>{getStepIcon(step.type)}</span>
                    {step.type === 'wait' ? (
                      <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <input
                          type="number"
                          value={getWaitDisplayValue(step.duration)}
                          onChange={e => updateWaitStep(index, humanToMs(parseFloat(e.target.value) || 0, getWaitDisplayUnit(step.duration)))}
                          min={0.1}
                          step={0.5}
                          style={{ padding: '0.4rem', borderRadius: 4, border: '1px solid #8e44ad', background: '#1a1a2e', color: '#fff', fontSize: '0.85rem', width: 80 }}
                        />
                        <span style={{ color: '#aaa', fontSize: '0.85rem' }}>{getWaitDisplayUnit(step.duration)} wait</span>
                      </div>
                    ) : (
                      <span style={{ flex: 1, fontSize: '0.9rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{step.name}</span>
                    )}
                    <button onClick={() => moveStep(index, -1)} disabled={index === 0} style={{ padding: '0.25rem', background: '#3498db', color: '#fff', border: 'none', borderRadius: 4, cursor: index === 0 ? 'not-allowed' : 'pointer', opacity: index === 0 ? 0.5 : 1, minWidth: 28, minHeight: 28 }}>↑</button>
                    <button onClick={() => moveStep(index, 1)} disabled={index === steps.length - 1} style={{ padding: '0.25rem', background: '#3498db', color: '#fff', border: 'none', borderRadius: 4, cursor: index === steps.length - 1 ? 'not-allowed' : 'pointer', opacity: index === steps.length - 1 ? 0.5 : 1, minWidth: 28, minHeight: 28 }}>↓</button>
                    <button onClick={() => removeStep(index)} style={{ padding: '0.25rem', background: '#e74c3c', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', minWidth: 28, minHeight: 28 }}>✕</button>
                  </div>
                ))}
              </div>
            )}

            <button
              onClick={editSequence ? updateSequence : saveSequence}
              disabled={!selectedProfile || !sequenceName || steps.length === 0}
              style={{
                marginTop: '1rem',
                padding: '0.75rem',
                background: (!selectedProfile || !sequenceName || steps.length === 0) ? '#555' : '#27ae60',
                color: '#fff',
                border: 'none',
                borderRadius: 6,
                cursor: (!selectedProfile || !sequenceName || steps.length === 0) ? 'not-allowed' : 'pointer',
                fontWeight: 500,
                fontSize: '1rem',
                width: '100%'
              }}
            >
              {editSequence ? 'Update Sequence' : 'Save Sequence'}
            </button>
          </section>
        </>
      )}
    </div>
  );
}

export default AutoloadBuilder;