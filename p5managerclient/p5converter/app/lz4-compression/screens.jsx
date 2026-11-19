// Home (library left to right) and the per-game page.
import {memo, useCallback, useState} from 'react';
import {View, Text, Image, ScrollView, FocusScope, useIsFocused} from '@ps5-react/core';
import {iconUrl} from './api.js';
import {REPORT_CHOICES, compatSummary} from './compat.js';
import donateQr from './assets/donate-qr.png';
import homeMark from './assets/home-mark.png';
import {
  ACTION_DESC, ACTION_ICON, ACTION_LABEL, GROUPS, badgeText, gameId, gameSize, kindLabel, opSummary,
  opTone, primaryAction, profileText, progressFor, resultText, secondaryActions, statusOf, storageLabel, formatBytes,
} from './model.js';
import {Dot, Glow, OptionCard, PrimaryButton, ProgressBar, SectionLabel, Spec, TopBar} from './ui.jsx';

// ---------------------------------------------------------------- home

// The artwork box reads the tile's focus (the tile is the focusable element).
function TileArt({children}) {
  const focused = useIsFocused();
  return (
    <View focused={focused} className="w-[132px] h-[132px] rounded-[20px] border-[3px] border-transparent
      overflow-hidden bg-raised transition focused:border-accent focused:scale-110">
      {children}
    </View>
  );
}

const Tile = memo(function Tile({game, onOpen, onFocusGame, autoFocus}) {
  const id = gameId(game);
  const badge = badgeText(game);
  const icon = iconUrl(game, false);
  return (
    <View onPress={() => onOpen(id)} onFocus={() => onFocusGame(id)} autoFocus={autoFocus}
      focusKey={'tile-' + id} className="w-[132px] gap-3">
      <TileArt>
        {icon ? <Image source={{uri: icon}} className="w-[126px] h-[126px] rounded-[17px] bg-raised" />
          : <View className="w-[126px] h-[126px] items-center justify-center">
            <Text className="font-heavy text-[18px] text-soft">{game.titleId.slice(4)}</Text>
          </View>}
        {badge ? (
          <View className="absolute left-[8px] bottom-[8px] h-[20px] px-2 rounded-full items-center justify-center bg-ink/80">
            <Text className="font-heavy text-[10px] text-snow tracking-[1px]">{badge}</Text>
          </View>
        ) : null}
        {game.activeOp ? (
          <View className="absolute left-0 right-0 bottom-0 h-[4px] bg-line">
            <View className="w-[45%] h-[4px] bg-accent animate-pulse" />
          </View>
        ) : null}
      </TileArt>
      <Text className="font-inter text-[13px] text-soft" numberOfLines={1}>{game.name || game.titleId}</Text>
    </View>
  );
});

function Hero({game, job}) {
  if (!game) return <View className="h-[220px]" />;
  const status = statusOf(game);
  const progress = progressFor(game, job);
  return (
    <View className="px-[48px] gap-3 h-[220px]">
      <Text className="font-semi text-[11px] text-muted tracking-[2px]">
        {[game.titleId, storageLabel(game), kindLabel(game)].join('   ·   ').toUpperCase()}
      </Text>
      <Text className="font-heavy text-[40px] text-snow" numberOfLines={1}>{game.name || game.titleId}</Text>
      <View className="flex-row items-center gap-6">
        <View className="flex-row items-center gap-2">
          <Dot tone={status.tone} />
          <Text className="font-semi text-[15px] text-snow">{status.text}</Text>
        </View>
        <Text className="font-inter text-[15px] text-soft">{gameSize(game)}</Text>
        {game.lz4Packed ? <Text className="font-inter text-[15px] text-soft">{`${game.lz4PackCount || 0} LZ4 packs`}</Text> : null}
        {game.savedBytes > 0 ? <Text className="font-inter text-[15px] text-good">{`Saved ${formatBytes(game.savedBytes)}`}</Text> : null}
      </View>
      {progress ? (
        <View className="w-[520px] gap-2 mt-1">
          <Text className="font-inter text-[13px] text-soft">
            {progress.label + (progress.percent !== null ? `  ${progress.percent.toFixed(0)}%` : '')}
          </Text>
          <ProgressBar percent={progress.percent} />
        </View>
      ) : null}
    </View>
  );
}

const RecentCard = memo(function RecentCard({op, game, onOpen}) {
  const icon = game ? iconUrl(game, false) : '';
  return (
    <View onPress={() => onOpen(game ? gameId(game) : '')} focusKey={'recent-' + op.id}
      className="flex-row items-center gap-3 w-[280px] h-[64px] px-3 rounded-[16px] bg-panel border border-line
        transition focused:border-accent focused:scale-[1.03]">
      {icon ? <Image source={{uri: icon}} className="w-[44px] h-[44px] rounded-[10px] bg-raised" />
        : <View className="w-[44px] h-[44px] rounded-[10px] bg-raised" />}
      <View className="flex-1 gap-[2px]">
        <Text className="font-semi text-[13px] text-snow" numberOfLines={1}>{op.displayName || op.titleId}</Text>
        <Text className="font-inter text-[11px] text-muted" numberOfLines={1}>{ACTION_LABEL[op.action] || op.action}</Text>
      </View>
      <View className="flex-row items-center gap-2">
        <Dot tone={opTone(op)} />
        <Text className="font-inter text-[11px] text-soft">{resultText(op)}</Text>
      </View>
    </View>
  );
});

export function Home({games, history, job, version, freeText, covered, hide, startId, onOpen, onHistory, onAbout, onPower}) {
  const [focusId, setFocusId] = useState(startId || '');
  const onFocusGame = useCallback(id => setFocusId(id), []);
  const focused = games.find(game => gameId(game) === focusId) || games[0] || null;
  const recent = history.slice(0, 3);
  const byTitle = new Map(games.map(game => [game.titleId, game]));
  const startIndex = Math.max(0, games.findIndex(game => gameId(game) === (startId || '')));
  return (
    <FocusScope autoFocus restoreFocus focusKey="screen-home" inert={covered} onBack={() => true}>
      <View className={hide ? 'hidden' : 'absolute inset-0 bg-ink'}>
        <Glow left={-420} top={-560} size={1200} />
        <Image source={homeMark} className="absolute right-[210px] top-[240px] w-[440px] h-[440px]" />
        <TopBar version={version} freeText={freeText} onHistory={onHistory} onAbout={onAbout} onPower={onPower} />
        <View className="flex-row items-center gap-3 px-[48px] mt-4">
          <Text className="font-semi text-[11px] text-accent tracking-[3px]">LIBRARY</Text>
          <Text className="font-inter text-[12px] text-muted">{`${games.length} ${games.length === 1 ? 'game' : 'games'}`}</Text>
        </View>
        {/* Embedded React scrolls the axis that overflows: the row goes on the ScrollView itself.
            Focus reveals keep a 32px margin, so the viewport starts 16px in and the first tile still
            lines up with the 48px gutter when the shelf scrolls back. */}
        <ScrollView horizontal className="flex-row h-[200px] mt-2 ml-[16px]">
          <View className="flex-row shrink-0 gap-5 pl-[32px] pr-[48px] pt-[18px]">
            {games.map((game, index) => (
              <Tile key={gameId(game)} game={game} onOpen={onOpen} onFocusGame={onFocusGame}
                autoFocus={index === startIndex} />
            ))}
          </View>
        </ScrollView>
        <View className="mt-3">
          <Hero game={focused} job={job} />
        </View>
        <View className="flex-1" />
        {recent.length ? (
          <View className="px-[48px] pb-[36px]">
            <Text className="font-semi text-[11px] text-accent tracking-[3px] mb-3">RECENT ACTIVITY</Text>
            <View className="flex-row gap-4">
              {recent.map(op => <RecentCard key={op.id} op={op} game={byTitle.get(op.titleId)} onOpen={onOpen} />)}
            </View>
          </View>
        ) : null}
        {/* Optional support, out of the way (as in PS5VR): a small dimmed QR code
            in the corner for buymeacoffee.com/theghostonline. */}
        <View className="absolute right-[48px] bottom-[36px] items-center gap-[10px]">
          <Image source={donateQr} className="w-[88px] h-[88px]" />
          <Text className="font-semi text-[16px] text-[#7f8c82]">Support LZ4 Compression</Text>
        </View>
      </View>
    </FocusScope>
  );
}

// ---------------------------------------------------------------- game page

function ProgressCard({progress, onCancel}) {
  return (
    <View className="w-[560px] gap-3 p-5 rounded-[20px] bg-panel border border-line">
      <View className="flex-row items-center">
        <Text className="font-semi text-[17px] text-snow flex-1">{progress.label}</Text>
        {progress.percent !== null ? <Text className="font-heavy text-[17px] text-snow">{`${progress.percent.toFixed(0)}%`}</Text> : null}
      </View>
      <ProgressBar percent={progress.percent} />
      {progress.detail ? <Text className="font-inter text-[12px] text-soft">{progress.detail}</Text> : null}
      {progress.current ? <Text className="font-inter text-[11px] text-muted" numberOfLines={1}>{progress.current}</Text> : null}
      {progress.cancelDisabled ? <Text className="font-inter text-[12px] text-warn">This step can't be cancelled.</Text>
        : <PrimaryButton label="Cancel" onPress={onCancel} autoFocus focusKey="cancel-job" />}
    </View>
  );
}

export function GamePage({game, job, covered, hide, depth, onBack, onAction, onCancel, onCancelQueued, version, compat, reported}) {
  if (!game) return null;
  const status = statusOf(game);
  const progress = progressFor(game, job);
  const primary = primaryAction(game);
  const actions = secondaryActions(game);
  const icon = iconUrl(game, true);
  const specs = [
    ['Title ID', game.titleId],
    ['Storage', storageLabel(game)],
    ['Format', kindLabel(game)],
    ['Size', gameSize(game)],
    ['State', status.text, status.tone],
  ];
  if (game.savedBytes > 0) specs.push(['Saved', formatBytes(game.savedBytes), 'good']);
  if (game.amprPresent) specs.push(['APR-EMU', game.amprVersion || 'Present']);
  if (game.lz4Packed) specs.push(['LZ4 packs', String(game.lz4PackCount || 0)]);
  else if (game.lz4Supported) specs.push(['LZ4 profile', profileText(game)]);
  // Glacier games (007, HITMAN) read their .rpkg files from disk, so packs can't work.
  if (game.lz4DiskPackages) {
    specs.push(['LZ4', game.lz4Packed ? "Won't start from packs, unpack it" : 'Not for this game', game.lz4Packed ? 'bad' : 'muted']);
  }
  if (game.lz4Packed || game.lz4Supported) {
    const community = compatSummary(compat && compat[game.titleId]);
    specs.push(['Community', community ? community.text : 'No reports yet', community ? community.tone : undefined]);
  }
  const mine = REPORT_CHOICES.find(choice => choice.status === reported);
  const descOf = id => (id === 'report-compat' && mine ? `You said: ${mine.label}` : ACTION_DESC[id]);
  const groups = GROUPS.map(([key, label, ids]) => [key, label, ids.filter(id => actions.includes(id))])
    .filter(([, , ids]) => ids.length);
  return (
    <FocusScope autoFocus restoreFocus focusKey={'screen-' + depth} inert={covered} onBack={() => { onBack(); return true; }}>
      <View className={hide ? 'hidden' : 'absolute inset-0 bg-ink'}>
        <Glow left={-420} top={-560} size={1200} />
        <TopBar version={version} trail={`/   ${game.name || game.titleId}`} />
        <ScrollView className="flex-1">
          <View className="px-[48px] pt-4 pb-[60px] gap-8">
            <View className="flex-row gap-10">
              {icon ? <Image source={{uri: icon}} className="w-[176px] h-[176px] rounded-[28px] bg-raised" />
                : <View className="w-[176px] h-[176px] rounded-[28px] bg-raised" />}
              <View className="flex-1 gap-4">
                <Text className="font-heavy text-[32px] text-snow" numberOfLines={2}>{game.name || game.titleId}</Text>
                <View className="flex-row flex-wrap gap-y-2">
                  {specs.map(([label, value, tone]) => <Spec key={label} label={label} value={value} tone={tone} />)}
                </View>
                <View className="mt-2 flex-row">
                  {progress ? <ProgressCard progress={progress} onCancel={onCancel} />
                    : game.pendingOp ? (
                      <View className="flex-row items-center gap-5">
                        <Text className="font-semi text-[16px] text-warn">Queued, waiting for the current job</Text>
                        <PrimaryButton label="Cancel" onPress={() => onCancelQueued(game.pendingOp.id)} autoFocus />
                      </View>
                    ) : primary ? (
                      <PrimaryButton label={ACTION_LABEL[primary]} onPress={() => onAction(primary)} autoFocus focusKey="primary" />
                    ) : <Text className="font-inter text-[14px] text-muted">Nothing to do for this copy right now.</Text>}
                </View>
              </View>
            </View>
            {groups.length ? (
              <View>
                <Text className="font-heavy text-[22px] text-snow mb-1">Options</Text>
                <View className="flex-row flex-wrap gap-x-5">
                  {groups.map(([key, label, ids]) => (
                    <View key={key} className="gap-3">
                      <SectionLabel>{label}</SectionLabel>
                      {ids.map(id => (
                        <OptionCard key={id} id={id} title={ACTION_LABEL[id]} desc={descOf(id)}
                          icon={ACTION_ICON[id]} danger={id === 'delete-game-data'} onOpen={onAction} />
                      ))}
                    </View>
                  ))}
                </View>
              </View>
            ) : game.activeOp || game.pendingOp ? (
              <Text className="font-inter text-[14px] text-muted">More options come back when this game's job finishes.</Text>
            ) : null}
            <View focusable className="py-2">
              <Text className="font-inter text-[12px] text-muted" numberOfLines={1}>{game.sourcePath}</Text>
            </View>
          </View>
        </ScrollView>
      </View>
    </FocusScope>
  );
}
