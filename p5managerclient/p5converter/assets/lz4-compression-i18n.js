(function (global) {
  'use strict';

  const DEFAULT_LOCALE = 'en';
  const catalogs = Object.create(null);
  const localeMeta = Object.create(null);
  const listeners = [];
  let currentLocale = DEFAULT_LOCALE;

  const english = {
    'app.name': 'LZ4 Compression',
    'app.documentTitle': 'LZ4 Compression',

    'common.applyVersion': 'Apply Version',
    'common.cancel': 'Cancel',
    'common.cancelled': 'Cancelled',
    'common.cached': 'Cached',
    'common.change': 'Change',
    'common.close': 'Close',
    'common.continueAnyway': 'Continue anyway',
    'common.current': 'Current',
    'common.destination': 'Destination',
    'common.done': 'Done',
    'common.download': 'Download',
    'common.failed': 'Failed',
    'common.files': 'Files',
    'common.image': 'Image',
    'common.installed': 'Installed',
    'common.latest': 'Latest',
    'common.output': 'Output',
    'common.select': 'Select',
    'common.selected': 'Selected',
    'common.success': 'Success',
    'common.pending': 'Pending',
    'common.source': 'Source',
    'common.start': 'Start',
    'common.unavailable': 'Unavailable',
    'common.working': 'Working...',

    'accessibility.about': 'About',
    'accessibility.aboutApp': 'About LZ4 Compression',
    'accessibility.cancelOperation': 'Cancel operation',
    'accessibility.colorMode': 'Color mode',
    'accessibility.copyPath': 'Copy path',
    'accessibility.darkMode': 'Dark mode',
    'accessibility.history': 'History',
    'accessibility.lightMode': 'Light mode',
    'accessibility.love': 'love',
    'accessibility.moreActions': 'More actions',
    'accessibility.palestine': 'Palestine',
    'accessibility.terminateApp': 'Close LZ4 Compression',

    'loading.scanningGames': 'Scanning games',
    'loading.storageTargets': 'Loading storage targets',
    'loading.externalStorage': 'Loading external storage',
    'games.scanFailed': 'Scan failed',
    'games.noneFound': 'No games found',
    'games.count.one': '{count} game',
    'games.count.other': '{count} games',

    'about.title': 'About',
    'about.notes': "Built on Game Compressor by Juma Sayeh and the LZ4 workflow from Lazy_AMPR by Nazky. Packed games are read by drakmor's ampr_emu. Unofficial, and not affiliated with either project.",

    'home.library': 'Library',
    'home.open': 'Open',
    'home.queued': 'Queued',
    'home.recent': 'Recent activity',
    'home.seeAll': 'See all',
    'home.scrollLeft': 'Scroll left',
    'home.scrollRight': 'Scroll right',
    'nav.library': 'Library',
    'nav.back': 'Back',
    'splash.ready': 'Ready',
    'done.title': 'Done',
    'done.ok': 'OK',

    'options.title': 'Options',
    'options.busy': 'More options come back when the current job for this game finishes.',
    'options.group.compress': 'Compress',
    'options.group.check': 'Check',
    'options.group.restore': 'Restore',
    'options.group.ampr': 'APR-EMU',
    'options.group.storage': 'Copy and move',
    'options.group.danger': 'Delete',
    'options.desc.compress': 'Pack the game into a compressed .ffpfsc image.',
    'options.desc.lz4-pack': 'Seekable LZ4 packs read while the game runs. APR-EMU is added if the game has none.',
    'options.desc.make-image': 'Build a plain .exfat or .ffpfs image from this folder.',
    'options.desc.validate-only': 'Read every block and report problems without changing anything.',
    'options.desc.validate-repair': 'Read every block and repair what it can.',
    'options.desc.lz4-verify': 'Check every LZ4 pack block and put back files the game needs on disk.',
    'options.desc.uncompress': 'Turn the compressed image back into an image or a folder.',
    'options.desc.lz4-unpack': 'Put the normal loose files back from the LZ4 packs.',
    'options.desc.extract-image': 'Copy the mounted image out to a normal folder.',
    'options.desc.set-read-only': 'Mount this image read-only in ShadowMount+.',
    'options.desc.choose-ampr-version': 'Pick which APR-EMU build this game uses.',
    'options.desc.restore-ampr-original': 'Put back the APR-EMU file the game came with.',
    'options.desc.build-ampr-index': 'Build the path index APR-EMU uses to find files fast.',
    'options.desc.update-ampr': 'Install the latest APR-EMU build.',
    'options.desc.copy-to': 'Copy the game to internal storage or a USB drive.',
    'options.desc.move-to': 'Move the game to internal storage or a USB drive.',
    'options.desc.delete-game-data': 'Permanently delete this copy of the game.',

    'theme.saveFailed': 'Could not save display mode',
    'settings.language': 'Language',
    'settings.systemLanguage': 'System language',

    'header.freeSpace': 'Free Space',
    'header.storageFree': '{storage} Free',
    'header.freeForPath': '{label} for {path}',

    'terminate.reminderTitle': 'Done processing.',
    'terminate.reminderText': 'Before playing, close LZ4 Compression to avoid minor game performance effects.',
    'terminate.confirm': 'Close LZ4 Compression now?\n\nRecommended before playing games because leaving it running can have minor effects on game performance.',
    'terminate.terminating': 'Closing LZ4 Compression',
    'terminate.terminated': 'LZ4 Compression closed',

    'history.title': 'History',
    'history.none': 'No operations',
    'history.outputPath': 'output: {path}',
    'history.saved': 'saved {size}',
    'history.scanPercent': 'scan: {percent}%',
    'history.scanSize': 'scan: {size}',
    'history.averageSpeed': 'avg {speed}',

    'storage.internalSsd': 'Internal SSD',
    'storage.externalSsd': 'External SSD',
    'storage.m2Ssd': 'M.2 SSD',
    'storage.externalStorage': 'External Storage',
    'storage.other': 'Other storage',
    'storage.generic': 'storage',
    'storage.usb': 'USB',
    'storage.usbNumber': 'USB {number}',
    'storage.freeOf': '{free} free of {total}',
    'storage.noTarget': 'No available storage target',
    'storage.noOtherUsb': 'No other USB with 10 MB free',
    'storage.connectOtherUsb': 'Connect another USB target with at least 10 MB free',
    'storage.noExternal': 'No external storage with 10 MB free',
    'storage.connectExternal': 'Connect external storage with at least 10 MB free',
    'storage.chooseInternalOrUsb': 'Choose Internal SSD or another USB target',
    'storage.imageTarget': 'Image target: {target}',
    'storage.compressionTarget': 'Compression target: {target}',
    'storage.moveTitle': 'Move {game} to...',
    'storage.copyTitle': 'Copy {game} to...',

    'status.canceling': 'Canceling',
    'status.resolving': 'Resolving',
    'status.measuring': 'Measuring',
    'status.closing': 'Closing',
    'status.hidingOtherInstances': 'Hiding other instances',
    'status.restoringOtherInstances': 'Restoring other instances',
    'status.mounting': 'Mounting',
    'status.deleting': 'Deleting',
    'status.aprIndexed': 'APR Indexed',
    'status.buildingAprIndex': 'Building APR Index',
    'status.amprUpdated': 'APR-EMU Updated',
    'status.rebuildingAmpr': 'Rebuilding APR-EMU',
    'status.updatingAmpr': 'Updating APR-EMU',
    'status.testingReadSpeed': 'Testing Read Speed',
    'status.updatingShadowMount': 'Updating ShadowMount',
    'status.publishing': 'Publishing',
    'status.inspecting': 'Inspecting',
    'status.finalizing': 'Finalizing',
    'status.restoring': 'Restoring',
    'status.transferring': 'Transferring',
    'status.copying': 'Copying',
    'status.extracting': 'Extracting',
    'status.repacking': 'Repacking',
    'status.makingImage': 'Making Image',
    'status.unpacking': 'Unpacking',
    'status.validating': 'Validating',
    'status.scanning': 'Scanning',
    'status.compressing': 'Compressing',
    'status.running': 'Running',
    'progress.eta': 'ETA:',
    'status.aprUpdate': 'APR update',
    'status.aprUpdateNeeded': 'APR update needed',
    'status.validated': 'validated',
    'status.changed': 'changed',
    'status.notValidated': 'not validated',
    'status.folder': 'folder',
    'status.image': 'image',
    'status.compressed': 'compressed',
    'status.unavailable': 'unavailable',
    'status.notMounted': 'not mounted',
    'status.onDemand': 'mounts when played',
    'status.aprOriginal': 'APR original',
    'status.aprCustom': 'APR custom',
    'status.aprVersion': 'APR v{version}',
    'status.currentOutput': 'current output',
    'status.originalSource': 'original source',
    'status.locations.one': '{count} location',
    'status.locations.other': '{count} locations',
    'status.savedSize': 'saved {size}',
    'status.sizeQueued': 'size queued',
    'status.scanningSize': 'scanning size',
    'status.measuredFolderSize': 'Measured folder size',
    'status.estimatedFolderSize': 'Estimated folder size, checking for updates',
    'status.cachedFolderSize': 'Cached estimated folder size for display only',
    'status.folderSize': 'Folder size',
    'status.badBlocks.one': '{count} bad block found',
    'status.badBlocks.other': '{count} bad blocks found',
    'status.repairedBlocks.one': '{count} block repaired',
    'status.repairedBlocks.other': '{count} blocks repaired',
    'status.openBadBlockLog': 'Open bad block log',

    'operation.action.updateAmpr': 'Update APR-EMU',
    'operation.action.validateRepair': 'Validate and Repair',
    'operation.action.revalidateRepair': 'Revalidate and Repair',
    'operation.action.compress': 'Compress',
    'operation.action.makeImage': 'Make Image',
    'operation.action.chooseAmpr': 'Choose APR-EMU Version',
    'operation.action.restoreAmpr': 'Restore Original APR-EMU',
    'operation.action.buildAprIndex': 'Build AMPR Index',
    'operation.action.validateOnly': 'Validate Only',
    'operation.action.uncompress': 'Uncompress',
    'operation.action.setReadOnly': 'Set Read Only',
    'operation.action.extractFolder': 'Extract to Folder',
    'operation.action.copyTo': 'Copy to...',
    'operation.action.moveTo': 'Move to...',
    'operation.action.deleteGameData': 'Delete Game Data',
    'operation.pending.compress': 'Pending Compress',
    'operation.pending.makeImage': 'Pending Make Image',
    'operation.pending.validate': 'Pending Validate',
    'operation.pending.mount': 'Pending Mount',
    'operation.pending.setReadOnly': 'Pending Set Read Only',
    'operation.pending.unpack': 'Pending Unpack',
    'operation.pending.extract': 'Pending Extract',
    'operation.pending.moveExternal': 'Pending Move to External Storage',
    'operation.pending.moveInternal': 'Pending Move to Internal SSD',
    'operation.pending.copyExternal': 'Pending Copy to External Storage',
    'operation.pending.copyInternal': 'Pending Copy to Internal SSD',
    'operation.pending.delete': 'Pending Delete',
    'operation.pending.aprIndex': 'Pending APR Index',
    'operation.pending.amprUpdate': 'Pending APR-EMU Update',
    'operation.pending.readSpeed': 'Pending Read Speed Test',
    'operation.pending.generic': 'Pending Operation',
    'operation.cancelAlreadyRequested': 'Cancel already requested',
    'operation.cancelUnavailable': 'Operation cannot be cancelled now',
    'operation.cancelUnsafe': 'Unsafe compression cannot be cancelled after it starts',
    'operation.mountNow': 'Mount now',
    'operation.testReadSpeed': 'Test read speed',
    'operation.readSpeed': 'Read speed',
    'operation.copyPathFailed': 'Could not copy path',
    'operation.mountFailed': 'Could not mount selected instance',
    'operation.readSpeedStartFailed': 'Could not start read speed test',
    'operation.direction.compressedInPlace': '{source} compressed in place',
    'operation.direction.madeImage': '{source} made into image',
    'operation.direction.unpackedInPlace': '{source} unpacked in place',
    'operation.direction.extractedFolder': '{source} extracted to folder',
    'operation.direction.amprUpdated': '{source} APR-EMU updated',
    'operation.direction.transfer': '{source} -> {target}',

    'result.outputExists': 'output already exists',
    'result.badBlocksNotMounted': "bad blocks found, didn't mount",
    'result.noBadBlocksNotMounted': "no bad blocks found, didn't mount",
    'result.badBlocksFound': 'bad blocks found',
    'result.noBadBlocksFound': 'no bad blocks found',
    'result.unpackedNotMounted': "unpacked, didn't mount",
    'result.mounted': 'mounted',
    'result.notMounted': 'not mounted',
    'result.alreadyReadOnly': 'already read-only',
    'result.setReadOnly': 'set read-only',
    'result.testedReadSpeed': 'tested read speed',
    'result.amprUpdated': 'APR-EMU updated',
    'result.verifiedNotMounted': "verified, didn't mount",

    'failure.compress': 'Compress failed',
    'failure.makeImage': 'Make image failed',
    'failure.unpack': 'Unpack failed',
    'failure.extract': 'Extract failed',
    'failure.validate': 'Validate failed',
    'failure.mount': 'Mount failed',
    'failure.setReadOnly': 'Set read-only failed',
    'failure.aprIndex': 'APR index failed',
    'failure.lz4Pack': 'LZ4 compression failed',
    'failure.lz4Unpack': 'LZ4 uncompress failed',
    'failure.lz4Verify': 'LZ4 verification failed',
    'operation.action.lz4Pack': 'Compress with LZ4',
    'operation.action.lz4Unpack': 'Uncompress LZ4',
    'operation.action.lz4Verify': 'Verify LZ4 Packs',
    'operation.pending.lz4Pack': 'Pending LZ4 Compression',
    'operation.pending.lz4Unpack': 'Pending LZ4 Uncompress',
    'operation.pending.lz4Verify': 'Pending LZ4 Verification',
    'operation.direction.lz4Packed': '{source} LZ4 packed',
    'operation.direction.lz4Unpacked': '{source} LZ4 unpacked',
    'status.lz4Planning': 'Planning LZ4 Packs',
    'status.lz4Compressing': 'Compressing (LZ4)',
    'status.lz4Verifying': 'Verifying LZ4 Packs',
    'status.lz4Removing': 'Removing Packed Originals',
    'community.none': 'Community: no reports yet',
    'community.allWork.one': 'Community: works for 1 person',
    'community.allWork.other': 'Community: works for all {count}',
    'community.allBroken.one': 'Community: broken for 1 person',
    'community.allBroken.other': 'Community: broken for all {count}',
    'community.some': 'Community: works for {working} of {count}',
    'community.report': 'Report how it runs',
    'update.available': 'v{version} is out',
    'status.lz4Packed.one': 'LZ4 Packed ({count} pack)',
    'status.lz4Packed.other': 'LZ4 Packed ({count} packs)',
    'lz4.dialogTitle': 'LZ4 Asset Packs',
    'lz4.dialogGame': 'Compress {game} with LZ4',
    'lz4.unpackDialogGame': 'Uncompress LZ4 packs for {game}',
    'lz4.compressHint': 'This game can use LZ4 asset packs instead: they shrink it and stay playable from a plain folder.',
    'lz4.useInstead': 'Use LZ4 packs instead',
    'lz4.output.title': 'Game folder with LZ4 asset packs',
    'lz4.output.unpackTitle': 'Original loose game folder',
    'lz4.output.inPlace': 'Updates {name} in place',
    'lz4.note.pack': 'Game data goes into seekable LZ4 packs that APR-EMU reads while the game runs. Executables, system files and media stay loose. Every packed file is checked byte for byte before anything is removed, and the pack-capable APR-EMU runtime is installed into fakelib (added if the game has none).',
    'lz4.note.unpack': 'Restores every packed file from the LZ4 packs and checks each block against its stored CRC. The pack-capable APR-EMU runtime stays in fakelib and also runs loose games.',
    'lz4.levelTitle': 'Compression Level',
    'lz4.level.fast': 'Fast',
    'lz4.level.max': 'Max',
    'lz4.level.metaFast': 'Level {n} · LZ4 fast mode, quickest',
    'lz4.level.metaBalanced': 'Level {n} · LZ4 HC, balanced',
    'lz4.level.metaDefault': 'Level {n} · LZ4 HC, the default',
    'lz4.level.metaHigh': 'Level {n} · LZ4 HC, smaller packs, slower',
    'lz4.level.metaMax': 'Level {n} · LZ4 HC, smallest and slowest',
    'lz4.profileTitle': 'Packing Profile',
    'lz4.profile.auto': 'Automatic',
    'lz4.profile.autoMeta': 'Scans the game and keeps executables, system files and media loose',
    'lz4.profile.autoBundled': '{label} profile, tested on {tested}',
    'lz4.profile.scan': 'Scan Only',
    'lz4.profile.scanMeta': 'Skip the bundled profile and scan the game',
    'lz4.profile.chipImported': 'LZ4: imported config',
    'lz4.profile.chipBundled': 'LZ4 profile: {label}',
    'lz4.profile.chipEngine': 'LZ4 profile: {label} (same engine)',
    'lz4.profile.chipScan': 'LZ4 profile: automatic scan',
    'lz4.profile.custom': 'Custom or Trace Config',
    'lz4.profile.customMissing': 'Upload a TOML config from a PC or phone, or import one from a USB drive or /data/LZ4Compression/import',
    'lz4.profile.customReady': 'profile.toml uploaded ({size})',
    'lz4.profile.missingIncludes': 'Upload the include lists this profile needs: {files}',
    'lz4.profile.uploading': 'Uploading profile',
    'lz4.profile.upload': 'Upload TOML',
    'lz4.profile.uploadList': 'Upload Include List',
    'lz4.profile.remove': 'Remove Config',
    'lz4.profile.importConsole': 'Import From Console',
    'lz4.profile.configMatch': '{name} (matches this game)',
    'lz4.profile.removeConfirm': 'Remove the custom LZ4 config for this game?',
    'lz4.profile.listMustBeTxt': 'Include lists must be .txt files.',
    'lz4.profile.ps5Unsupported': 'The PS5 browser cannot pick files. Open LZ4 Compression from a PC or phone browser on the same network to upload a profile.',
    'lz4.destination.inPlace': 'Next to the game',
    'lz4.destination.inPlaceMeta': 'Write to the same storage',
    'lz4.destination.internalMeta': 'Write to /data/homebrew',
    'lz4.destination.usbMeta': 'Write to the USB target below',
    'lz4.policy.replace': 'Pack in place',
    'lz4.policy.replaceMeta': 'Verified first, then packed originals are removed. Needs the least space',
    'lz4.policy.replaceUnpack': 'Unpack in place',
    'lz4.policy.replaceUnpackMeta': 'Restores files inside this folder, then removes the packs',
    'lz4.startPack': 'Compress with LZ4',
    'lz4.startUnpack': 'Uncompress LZ4',
    'failure.amprUpdate': 'APR-EMU update failed',
    'failure.readSpeed': 'Read speed failed',
    'failure.operation': 'Operation failed',

    'ampr.versionTitle': 'APR-EMU Version',
    'ampr.versionTitleGame': 'APR-EMU Version - {game}',
    'ampr.availableVersions': 'Available Versions',
    'ampr.uploadCustom': 'Upload Custom File',
    'ampr.loadingVersions': 'Loading APR-EMU versions',
    'ampr.noVersions': 'No APR-EMU versions cached or available',
    'ampr.size': 'Size {size}',
    'ampr.sizeAfterDownload': 'Size after download',
    'ampr.sha': 'SHA {sha}',
    'ampr.shaAfterDownload': 'SHA after download',
    'ampr.storedOnPs5': 'stored on PS5',
    'ampr.downloadsBeforeApplying': 'downloads before applying',
    'ampr.applying': 'Applying...',
    'ampr.preparing': 'Preparing APR-EMU',
    'ampr.selectedInstalled': 'Selected version is already installed.',
    'ampr.selectedCached': 'Selected version is cached and ready to apply.',
    'ampr.selectedDownload': 'Selected version will be downloaded, cached, then applied.',
    'ampr.customPs5Unsupported': 'Upload custom libSceAmpr from your computer. Not supported on PS5 browser.',
    'ampr.hashingUpload': 'Hashing and uploading custom APR-EMU file',
    'ampr.applyingCustom': 'Applying custom APR-EMU file',
    'ampr.applyingCached': 'Applying cached APR-EMU version',
    'ampr.downloadingPreparing': 'Downloading and preparing APR-EMU',
    'ampr.error.manifestFetch': 'APR-EMU manifest fetch failed',
    'ampr.error.manifestMissing': 'APR-EMU manifest did not include libSceAmpr.sprx',
    'ampr.error.download': 'APR-EMU binary download failed',
    'ampr.error.updateCheck': 'APR-EMU update check failed',
    'ampr.error.customEmpty': 'Custom APR-EMU file is empty',
    'ampr.error.customHash': 'Custom APR-EMU SHA-256 could not be computed',
    'ampr.error.latestUnavailable': 'APR-EMU latest cache is unavailable',
    'ampr.error.update': 'APR-EMU update failed',
    'ampr.error.restore': 'Original APR-EMU restore failed',
    'ampr.error.versionList': 'APR-EMU version list failed',
    'ampr.error.customUpload': 'Custom APR-EMU upload failed',
    'ampr.error.noDownloadUrl': 'Selected APR-EMU version has no download URL',
    'ampr.error.noSha': 'Selected APR-EMU SHA-256 is unavailable',
    'ampr.error.apply': 'APR-EMU version apply failed',

    'compress.dialogTitle': 'Compression Format',
    'compress.dialogGame': 'Compress {game}',
    'compress.makeImageGame': 'Make Image {game}',
    'compress.archive': 'Compressed archive (.ffpfsc)',
    'compress.makeImageHint': 'Need a direct .exfat or .ffpfs file?',
    'compress.makeImageInstead': 'Make Image instead',
    'compress.innerImageFormat': 'Inner image format',
    'compress.innerImageFormatTitle': 'Inner Image Format',
    'compress.imageFormatTitle': 'Image Format',
    'compress.pfsExperimental': 'PFS Experimental',
    'compress.pfsExperimentalFile': 'Experimental - pfs_image.dat',
    'compress.inPlace': 'Compress in place',
    'compress.makeImageInPlace': 'Make image in place',
    'compress.writeCurrent': 'Write next to the current game',
    'compress.writeImageCurrent': 'Write image next to the current game',
    'compress.writeInternal': 'Write compressed file to /data/homebrew',
    'compress.writeImageInternal': 'Write image to /data/homebrew',
    'compress.writeUsb': 'Write compressed file to the USB target below',
    'compress.writeImageUsb': 'Write image to the USB target below',
    'compress.makeImageExternal': 'Make image to external storage',
    'compress.compressTo': 'Compress to...',
    'compress.makeImageTo': 'Make image to...',
    'compress.originalHandling': 'Original Handling',
    'compress.keepOriginal': 'Keep original',
    'compress.originalUntouched': 'Original remains untouched',
    'compress.deleteVerified': 'Delete after verified',
    'compress.requiresFullSize': 'Requires full-size free space',
    'compress.destructive': 'Destructive',
    'compress.requiresOneGb': 'Requires 1 GB free space',
    'compress.notForImage': 'Not available for image creation',
    'compress.exfatImage': 'exFAT image',
    'compress.exfatInside': 'exFAT inside .ffpfsc',
    'compress.pfsImageExperimental': 'PFS image experimental',
    'compress.pfsInsideExperimental': 'PFS inside .ffpfsc experimental',
    'compress.createsExfat': 'Creates {titleId}.ffpfsc with internal exFAT',
    'compress.createsPfs': 'Creates {titleId}.ffpfsc with pfs_image.dat',
    'compress.safe.target': 'Requires target free space; deletes after verification',
    'compress.safe.ssd': 'Requires SSD free space; deletes after verification',
    'compress.safe.measuring': 'Measuring required free space',
    'compress.safe.short': 'Requires {required} free; {extra} short',
    'compress.safe.ready': 'Requires {required} free; deletes after verification',
    'compress.destructive.sameStorage': 'Requires same storage',
    'compress.destructive.folderOnly': 'Requires folder source',
    'compress.destructive.base': 'Requires {required} free; deletes while writing',
    'compress.destructive.short': '{base}; {extra} short',

    'uncompress.dialogTitle': 'Uncompress',
    'uncompress.dialogGame': 'Uncompress {game}',
    'uncompress.detectingImage': 'Detecting image type',
    'uncompress.imageOutput': 'Image output',
    'uncompress.appFolder': 'App folder',
    'uncompress.inPlace': 'In place',
    'uncompress.writeCompressed': 'Write next to the compressed image',
    'uncompress.writeInternal': 'Write to /data/homebrew',
    'uncompress.writeUsb': 'Write to the USB target below',
    'uncompress.originalSource': 'Original source',
    'uncompress.keepBoth': 'Keep both',
    'uncompress.keepCompressed': 'Leave the compressed image after output is written',
    'uncompress.deleteAfter': 'Delete after completion',
    'uncompress.removeCompressed': 'Remove the compressed image after output is ready',
    'uncompress.writeAndKeep': 'Write next to the compressed image and keep the compressed source',
    'uncompress.writeAndRemove': 'Write next to the compressed image and remove it after output is ready',
    'uncompress.exfatImage': 'exFAT image',
    'uncompress.pfsImage': 'PFS image',

    'delete.dialogTitle': 'Delete Game Data',
    'delete.dialogGame': 'Delete {game}',
    'delete.gameData': 'Game data',
    'delete.warning': 'This permanently deletes the selected game data from storage. This cannot be undone.',
    'delete.warningSource': 'This permanently deletes the selected {source} from storage. This cannot be undone.',
    'delete.source.compressed': 'compressed image',
    'delete.source.image': 'image file',
    'delete.source.folder': 'game folder',
    'delete.source.gameData': 'game data',

    'error.scanGames': 'Could not scan games',
    'error.spaceCheckRetry': 'Could not check free storage for this target.\n\nYou can continue, but compression may fail if storage is actually low. The original will be kept until the new file is complete and verified.',
    'error.retryTargetMissing': 'Could not find the original target storage for this retry.',
    'error.lowSpace': 'Not enough free storage.\n\nFree {extra} more on the target storage.',
    'error.lowSpaceDestructive': 'Not enough free storage for destructive compression.\n\nDestructive deletes the source while writing and cannot be cancelled after it starts. It requires {required} free. Free {extra} more on the target storage.',
    'error.lowSpaceSafe': 'Not enough free storage for safe {operation}.\n\nSafe keeps the original until the new file is complete and verified. It requires {required} free. Free {extra} more on the target storage.',
    'error.imageCreation': 'image creation',
    'error.compression': 'compression',
    'error.keepOriginalNeeds': 'Free {extra} more to keep the original untouched until the new file is complete.',
    'error.saferPathConfirm': 'Not enough free storage for the safer path.\n\nDelete while processing can damage the original source if the operation stops.\n\n{detail}',
    'error.lowSpaceDetail': 'Not enough free storage.\n\n{detail}'
  };

  function normalizeLocale(locale) {
    return String(locale || DEFAULT_LOCALE).trim().replace(/_/g, '-').toLowerCase() || DEFAULT_LOCALE;
  }

  function localeCandidates(locale) {
    const normalized = normalizeLocale(locale);
    const language = normalized.split('-')[0];
    return normalized === language ? [normalized] : [normalized, language];
  }

  function catalogFor(locale) {
    const candidates = localeCandidates(locale);
    for (let i = 0; i < candidates.length; i++) {
      if (catalogs[candidates[i]]) return catalogs[candidates[i]];
    }
    return catalogs[DEFAULT_LOCALE];
  }

  function pluralCategory(locale, count) {
    const language = normalizeLocale(locale).split('-')[0];
    const integer = Math.floor(Math.abs(Number(count)));
    if (language === 'ar') {
      if (integer === 0) return 'zero';
      if (integer === 1) return 'one';
      if (integer === 2) return 'two';
      const mod100 = integer % 100;
      if (mod100 >= 3 && mod100 <= 10) return 'few';
      if (mod100 >= 11 && mod100 <= 99) return 'many';
      return 'other';
    }
    if (language === 'fr') return integer === 0 || integer === 1 ? 'one' : 'other';
    return integer === 1 ? 'one' : 'other';
  }

  function catalogValue(catalog, key, category) {
    if (category) {
      const exactVariant = key + '.' + category;
      if (Object.prototype.hasOwnProperty.call(catalog, exactVariant)) return catalog[exactVariant];
      if (category !== 'one') {
        const otherVariant = key + '.other';
        if (Object.prototype.hasOwnProperty.call(catalog, otherVariant)) return catalog[otherVariant];
      }
    }
    if (Object.prototype.hasOwnProperty.call(catalog, key)) return catalog[key];
    return undefined;
  }

  function valueFor(key, params) {
    const count = params && Number(params.count);
    const category = Number.isFinite(count) ? pluralCategory(currentLocale, count) : '';
    const selected = catalogFor(currentLocale) || {};
    const fallback = catalogs[DEFAULT_LOCALE] || {};
    const localized = catalogValue(selected, key, category);
    if (typeof localized !== 'undefined') return localized;
    const fallbackCategory = Number.isFinite(count) ? (count === 1 ? 'one' : 'other') : '';
    const fallbackValue = catalogValue(fallback, key, fallbackCategory);
    if (typeof fallbackValue !== 'undefined') return fallbackValue;
    return key;
  }

  function t(key, params) {
    const template = String(valueFor(String(key || ''), params));
    if (!params) return template;
    return template.replace(/\{([A-Za-z0-9_]+)\}/g, function (match, name) {
      return Object.prototype.hasOwnProperty.call(params, name)
        ? String(params[name])
        : match;
    });
  }

  function paramsForElement(element) {
    const raw = element.getAttribute('data-i18n-params');
    if (!raw) return undefined;
    try {
      return JSON.parse(raw);
    } catch (err) {
      return undefined;
    }
  }

  function applyElement(element) {
    const params = paramsForElement(element);
    const textKey = element.getAttribute('data-i18n');
    const titleKey = element.getAttribute('data-i18n-title');
    const ariaKey = element.getAttribute('data-i18n-aria-label');
    const placeholderKey = element.getAttribute('data-i18n-placeholder');
    if (textKey) element.textContent = t(textKey, params);
    if (titleKey) element.setAttribute('title', t(titleKey, params));
    if (ariaKey) element.setAttribute('aria-label', t(ariaKey, params));
    if (placeholderKey) element.setAttribute('placeholder', t(placeholderKey, params));
  }

  function applyToDom(root) {
    const scope = root || document;
    if (scope.nodeType === 1 && scope.matches && scope.matches(
      '[data-i18n], [data-i18n-title], [data-i18n-aria-label], [data-i18n-placeholder]')) {
      applyElement(scope);
    }
    if (!scope.querySelectorAll) return;
    scope.querySelectorAll(
      '[data-i18n], [data-i18n-title], [data-i18n-aria-label], [data-i18n-placeholder]'
    ).forEach(applyElement);
  }

  function metaFor(locale) {
    const candidates = localeCandidates(locale);
    for (let i = 0; i < candidates.length; i++) {
      if (localeMeta[candidates[i]]) return localeMeta[candidates[i]];
    }
    return localeMeta[DEFAULT_LOCALE];
  }

  function applyDocumentLocale() {
    if (typeof document === 'undefined') return;
    const meta = metaFor(currentLocale) || {};
    document.documentElement.lang = currentLocale;
    document.documentElement.dir = meta.direction === 'rtl' ? 'rtl' : 'ltr';
  }

  function registerLocale(locale, catalog, options) {
    const normalized = normalizeLocale(locale);
    const base = catalogs[normalized] || {};
    catalogs[normalized] = Object.assign(base, catalog || {});
    localeMeta[normalized] = Object.assign(localeMeta[normalized] || {}, options || {});
    return normalized;
  }

  function setLocale(locale) {
    const normalized = normalizeLocale(locale);
    const previousLocale = currentLocale;
    currentLocale = normalized;
    applyDocumentLocale();
    if (typeof document !== 'undefined' && document.documentElement) applyToDom(document);
    const detail = { locale: currentLocale, previousLocale: previousLocale };
    listeners.slice().forEach(function (listener) {
      try { listener(detail); } catch (err) { }
    });
    if (typeof global.CustomEvent === 'function' && global.dispatchEvent) {
      global.dispatchEvent(new CustomEvent('lz4compression:localechange', { detail: detail }));
    }
    return currentLocale;
  }

  function onLocaleChange(listener) {
    if (typeof listener !== 'function') return function () { };
    listeners.push(listener);
    return function () {
      const index = listeners.indexOf(listener);
      if (index >= 0) listeners.splice(index, 1);
    };
  }

  registerLocale(DEFAULT_LOCALE, english, { direction: 'ltr', label: 'English' });

  const api = {
    DEFAULT_LOCALE: DEFAULT_LOCALE,
    applyToDom: applyToDom,
    getCatalog: function (locale) { return catalogFor(locale); },
    getLocale: function () { return currentLocale; },
    getLocales: function () { return Object.keys(catalogs); },
    getLocaleMeta: function (locale) { return Object.assign({}, metaFor(locale) || {}); },
    onLocaleChange: onLocaleChange,
    registerLocale: registerLocale,
    setLocale: setLocale,
    t: t
  };

  global.Lz4CompressionI18n = api;
  global.registerLz4CompressionLocale = registerLocale;
  global.setLz4CompressionLocale = setLocale;
  global.lz4CompressionT = t;
  applyDocumentLocale();
})(window);
