// LZ4 Compression: native PS5 app for the LZ4 Compression engine (payload).
import {useCallback, useEffect, useRef, useState} from 'react';
import {AppRegistry, BackHandler, Controller, View, useFocus, useNavigationEvents} from '@ps5-react/core';
import {api, startEngine} from './api.js';
import {checkForUpdate, cleanupUpdate} from './update.js';
import {loadCompat, loadReported, markReported} from './compat.js';
import {ACTION_PAGES, formatBytes, gameId, readableError, stabilize} from './model.js';
import {GamePage, Home} from './screens.jsx';
import {
  AboutPage, CompressPage, ConfigPage, DeletePage, DoneOverlay, HistoryPage, Lz4Page, MovePage, Offline, PowerPage,
  ReportPage, Splash, Toast, UncompressPage, UpdateOverlay,
} from './pages.jsx';

const JOB_POLL_MS = 1000;
const LIST_POLL_MS = 6000;
const UPDATE_CHECK_DELAY_MS = 4000;
const COMPAT_REFRESH_MS = 10 * 60 * 1000;
const SPLASH_MS = 1900;

// A light tick on every focus move, a firmer one on presses, like Overdrive.
function useHaptics() {
  useNavigationEvents(event => {
    try {
      if (event.type === 'move') Controller.vibrate(0.22, 24);
      else if (event.type === 'press' && event.handled) Controller.vibrate(0.4, 36);
      else if (event.type === 'blocked') Controller.vibrate(0.12, 16);
    } catch (err) {
      // Vibration is a nicety; never let it break navigation.
    }
  });
}

// Holds the focused key and focus() for the app without re-rendering it on
// every D-pad move (useFocus re-renders whoever calls it).
function FocusBridge({bridge}) {
  const {focusedKey, focus} = useFocus();
  bridge.current.key = focusedKey;
  bridge.current.focus = focus;
  return null;
}

function freeSpaceText(games) {
  const internal = games.find(game => String(game.sourcePath || '').startsWith('/data/') && game.freeBytes > 0);
  return internal ? `Internal SSD  ${formatBytes(internal.freeBytes)} free` : '';
}

function lowSpaceText(err) {
  const data = err.data || {};
  if (data.lowSpace) {
    const extra = data.extraBytes ? formatBytes(data.extraBytes) : '';
    return extra ? `Not enough free space: ${extra} more is needed.` : 'Not enough free space.';
  }
  return readableError(err.message) || 'The engine refused the request.';
}

function App() {
  const [phase, setPhase] = useState('connecting');
  const [splashText, setSplashText] = useState('Connecting to the engine');
  const [offlineText, setOfflineText] = useState('');
  const [version, setVersion] = useState('');
  const [games, setGames] = useState([]);
  const [history, setHistory] = useState([]);
  const [job, setJob] = useState({busy: false});
  const [stack, setStack] = useState([{name: 'home'}]);
  const [toast, setToast] = useState(null);
  const [done, setDone] = useState(null);
  const [imported, setImported] = useState({id: '', count: 0});
  const [update, setUpdate] = useState(null);
  const [compat, setCompat] = useState({});
  const [reported, setReported] = useState(() => loadReported());
  const lastActive = useRef('');
  const toastTimer = useRef(0);
  const focusBridge = useRef({key: null, focus: () => false});
  const restoreTo = useRef(null);
  const doneFrom = useRef(null);
  useHaptics();

  const showToast = useCallback((title, text, error) => {
    setToast({title, text, error});
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), error ? 6000 : 3000);
  }, []);

  const refreshAll = useCallback(async () => {
    const [gameData, historyData, jobData] = await Promise.all([
      api.games(), api.history(), api.job().catch(() => null),
    ]);
    setGames(previous => stabilize(previous, gameData.games || []));
    setHistory(historyData.history || []);
    if (jobData) setJob(jobData);
  }, []);

  const connect = useCallback(async (startIt) => {
    setPhase('connecting');
    const started = Date.now();
    const ready = async () => {
      try {
        const status = await api.status();
        setVersion(status.version || '');
        return true;
      } catch (err) {
        return false;
      }
    };
    let ok = await ready();
    if (!ok && startIt !== false) {
      setSplashText('Starting the engine');
      try {
        await startEngine();
      } catch (err) {
        // Payload Manager isn't there; the offline screen explains.
      }
      for (let i = 0; i < 20 && !ok; i++) {
        await new Promise(resolve => setTimeout(resolve, 750));
        ok = await ready();
      }
    }
    if (!ok) {
      setOfflineText('');
      setPhase('offline');
      return;
    }
    setSplashText('Scanning games');
    try {
      await refreshAll();
    } catch (err) {
      setOfflineText(err.message || '');
      setPhase('offline');
      return;
    }
    // Long enough for the splash's clamp to close.
    const wait = Math.max(0, SPLASH_MS - (Date.now() - started));
    setTimeout(() => setPhase('ready'), wait);
  }, [refreshAll]);

  useEffect(() => { connect(true); }, [connect]);

  // A newer release shows the update dialog a few seconds after the library loads.
  useEffect(() => {
    if (phase !== 'ready') return undefined;
    const id = setTimeout(async () => {
      try {
        cleanupUpdate();
        const found = await checkForUpdate();
        console.log(`lz4: update check: ${found ? 'v' + found.version : 'up to date'}`);
        setUpdate(found);
      } catch (err) {
        // No network, or the release page is unreachable: try again next launch.
        console.log(`lz4: update check failed: ${err.message}`);
      }
    }, UPDATE_CHECK_DELAY_MS);
    return () => clearTimeout(id);
  }, [phase]);

  // Community game reports, refreshed now and then.
  useEffect(() => {
    if (phase !== 'ready') return undefined;
    let alive = true;
    const load = () => loadCompat().then(games => {
      console.log(`lz4: game reports for ${Object.keys(games).length} games`);
      if (alive) setCompat(games);
    }).catch(() => {});
    load();
    const id = setInterval(load, COMPAT_REFRESH_MS);
    return () => { alive = false; clearInterval(id); };
  }, [phase]);

  const onReported = useCallback((titleId, status) => {
    markReported(titleId, status);
    setReported(previous => ({...previous, [titleId]: status}));
  }, []);

  // Job every second; games and history every few seconds, and right away when a job ends.
  useEffect(() => {
    if (phase !== 'ready') return undefined;
    let tick = 0;
    const timer = setInterval(async () => {
      tick++;
      try {
        const jobData = await api.job();
        setJob(jobData);
        const active = String(jobData.activeId || '');
        const previous = lastActive.current;
        lastActive.current = active;
        const finished = previous && active !== previous;
        if (finished || tick % (jobData.busy ? 3 : Math.round(LIST_POLL_MS / JOB_POLL_MS)) === 0) {
          await refreshAll();
        }
        if (finished) {
          const data = await api.history();
          const op = (data.history || []).find(item => String(item.id) === previous);
          if (op && op.status !== 'cancelled') {
            doneFrom.current = focusBridge.current.key;
            setDone(op);
          }
        }
      } catch (err) {
        // The engine went away (closed from the web page, or crashed).
      }
    }, JOB_POLL_MS);
    return () => clearInterval(timer);
  }, [phase, refreshAll]);

  // Each page remembers what opened it, so closing it puts focus back there.
  const push = useCallback(entry => {
    const from = focusBridge.current.key;
    setStack(previous => [...previous, {...entry, from}]);
  }, []);
  const pop = useCallback(() => setStack(previous => {
    if (previous.length <= 1) return previous;
    restoreTo.current = previous[previous.length - 1].from || null;
    return previous.slice(0, -1);
  }), []);
  const depth = stack.length - 1;

  // Give focus back to the screen that is uncovered.
  const lastDepth = useRef(0);
  useEffect(() => {
    // After the commit, once the uncovered screen is no longer inert.
    if (depth < lastDepth.current) {
      const from = restoreTo.current;
      restoreTo.current = null;
      setTimeout(() => {
        const {focus} = focusBridge.current;
        if (!(from && focus(from))) focus(depth === 0 ? 'screen-home' : 'screen-' + depth);
      }, 0);
    }
    lastDepth.current = depth;
  }, [depth]);

  const top = stack[stack.length - 1];
  const gameOf = entry => (entry && entry.id ? games.find(game => gameId(game) === entry.id) : null);

  const openGame = useCallback(id => { if (id) push({name: 'game', id}); }, [push]);

  // Start a job from an action page, then go back to the game page to watch it.
  const startFrom = useCallback(async (request, label) => {
    try {
      await request();
      showToast(`${label} started`, '');
      pop();
      refreshAll().catch(() => {});
    } catch (err) {
      showToast("Couldn't start", lowSpaceText(err), true);
    }
  }, [pop, refreshAll, showToast]);

  const onAction = useCallback(async action => {
    const entry = stack[stack.length - 1];
    const game = gameOf(entry);
    if (!game) return;
    const page = ACTION_PAGES[action];
    if (page) {
      push({name: page, id: entry.id, action});
      return;
    }
    try {
      if (action === 'update-ampr') await api.updateAmpr(game);
      else await api.run(action, game);
      showToast('Started', game.name || game.titleId);
      refreshAll().catch(() => {});
    } catch (err) {
      showToast("Couldn't start", lowSpaceText(err), true);
    }
  }, [stack, games, push, refreshAll, showToast]);

  const cancelJob = useCallback(async () => {
    try {
      await api.cancelJob();
      showToast('Cancelling', 'The job stops at the next safe point.');
    } catch (err) {
      showToast("Couldn't cancel", err.message, true);
    }
  }, [showToast]);

  const cancelQueued = useCallback(async id => {
    try {
      await api.cancelQueued(id);
      refreshAll().catch(() => {});
    } catch (err) {
      showToast("Couldn't cancel", err.message, true);
    }
  }, [refreshAll, showToast]);

  const stop = useCallback(async stopEngine => {
    if (stopEngine !== false) {
      try {
        await api.shutdown();
      } catch (err) {
        // Closing anyway.
      }
    }
    BackHandler.exitApp();
  }, []);

  const bridge = <FocusBridge bridge={focusBridge} />;
  if (phase === 'connecting') return <>{bridge}<Splash status={splashText} /></>;
  if (phase === 'offline') {
    return <>{bridge}<Offline message={offlineText} onStart={() => connect(true)} onRetry={() => connect(false)} /></>;
  }

  const pages = stack.slice(1).map((entry, index) => {
    const level = index + 1;
    const covered = level < depth || !!done || !!update;
    const hide = level < depth;
    const game = gameOf(entry);
    const common = {key: `${level}-${entry.name}`, depth: level, covered, hide, onBack: pop};
    if (entry.name === 'game') {
      return <GamePage {...common} game={game} job={job} version={version} onAction={onAction}
        onCancel={cancelJob} onCancelQueued={cancelQueued} compat={compat} reported={reported[game ? game.titleId : ''] || ''} />;
    }
    if (entry.name === 'history') return <HistoryPage {...common} history={history} />;
    if (entry.name === 'about') return <AboutPage {...common} version={version} />;
    if (entry.name === 'power') return <PowerPage {...common} onStop={stop} />;
    if (!game) return null;
    if (entry.name === 'compress') return <CompressPage {...common} game={game} action={entry.action} onStart={startFrom} />;
    if (entry.name === 'lz4') {
      return <Lz4Page {...common} game={game} mode={entry.action === 'lz4-unpack' ? 'unpack' : 'pack'} onStart={startFrom}
        profileRev={imported.id === entry.id ? imported.count : 0} onImport={() => push({name: 'configs', id: entry.id})} />;
    }
    if (entry.name === 'configs') {
      return <ConfigPage {...common} game={game} onImported={name => {
        setImported(previous => ({id: entry.id, count: previous.count + 1}));
        showToast('Config imported', name);
        pop();
      }} />;
    }
    if (entry.name === 'uncompress') return <UncompressPage {...common} game={game} onStart={startFrom} />;
    if (entry.name === 'report') {
      return <ReportPage {...common} game={game} reported={reported[game.titleId] || ''} onReported={onReported} />;
    }
    if (entry.name === 'move') return <MovePage {...common} game={game} copy={entry.action === 'copy-to'} onStart={startFrom} />;
    if (entry.name === 'delete') {
      return <DeletePage {...common} game={game} onStart={(request, label) => {
        startFrom(request, label).then(() => setStack([{name: 'home'}]));
      }} />;
    }
    return null;
  });

  const doneGame = done ? games.find(game => game.titleId === done.titleId) : null;
  // Games only: apps (homebrew, media apps) mounted next to them stay out of the library.
  const library = games.filter(game => !game.isApp);
  return (
    <View className="w-screen h-screen bg-ink">
      {bridge}
      <Home games={library} history={history} job={job} version={version} freeText={freeSpaceText(games)}
        covered={depth > 0 || !!done || !!update} hide={depth > 0} onOpen={openGame}
        onHistory={() => push({name: 'history'})} onAbout={() => push({name: 'about'})} onPower={() => push({name: 'power'})} />
      {pages}
      {done ? <DoneOverlay op={done} game={doneGame} onClose={() => {
        setDone(null);
        const from = doneFrom.current;
        setTimeout(() => {
          const {focus} = focusBridge.current;
          if (!(from && focus(from))) focus(depth === 0 ? 'screen-home' : 'screen-' + depth);
        }, 0);
      }} /> : null}
      {update && !done ? <UpdateOverlay update={update} jobBusy={!!job.busy} onClose={() => {
        setUpdate(null);
        setTimeout(() => {
          const {focus} = focusBridge.current;
          focus(depth === 0 ? 'screen-home' : 'screen-' + depth);
        }, 0);
      }} /> : null}
      <Toast toast={toast} />
    </View>
  );
}

AppRegistry.registerComponent('lz4-compression', () => App);
