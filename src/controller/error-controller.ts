import { Events } from '../events';
import { ErrorDetails, ErrorTypes } from '../errors';
import { PlaylistContextType, PlaylistLevelType } from '../types/loader';
import {
  getRetryConfig,
  isTimeoutError,
  shouldRetry,
} from '../utils/error-helper';
import { findFragmentByPTS } from './fragment-finders';
import { HdcpLevel, HdcpLevels, type Level } from '../types/level';
import { logger } from '../utils/logger';
import type Hls from '../hls';
import type { RetryConfig } from '../config';
import type { NetworkComponentAPI } from '../types/component-api';
import type { ErrorData } from '../types/events';
import type { Fragment } from '../loader/fragment';
import type { LevelDetails } from '../hls';

const RENDITION_PENALTY_DURATION_MS = 300000;

export const enum NetworkErrorAction {
  DoNothing = 0,
  SendEndCallback = 1, // Reserved for future use
  SendAlternateToPenaltyBox = 2,
  RemoveAlternatePermanently = 3, // Reserved for future use
  InsertDiscontinuity = 4, // Reserved for future use
  RetryRequest = 5,
}

export const enum ErrorActionFlags {
  None = 0,
  MoveAllAlternatesMatchingHost = 1,
  MoveAllAlternatesMatchingHDCP = 1 << 1,
  SwitchToSDR = 1 << 2, // Reserved for future use
}

export type IErrorAction = {
  action: NetworkErrorAction;
  flags: ErrorActionFlags;
  retryCount?: number;
  retryConfig?: RetryConfig;
  hdcpLevel?: HdcpLevel;
  nextAutoLevel?: number;
  resolved?: boolean;
};

type PenalizedRendition = {
  lastErrorPerfMs: number;
  errors: ErrorData[];
  details?: LevelDetails;
};

type PenalizedRenditions = { [key: number]: PenalizedRendition };

export default class ErrorController implements NetworkComponentAPI {
  private readonly hls: Hls;
  private playlistError: number = 0;
  private penalizedRenditions: PenalizedRenditions = {};
  private log: (msg: any) => void;
  private warn: (msg: any) => void;
  private error: (msg: any) => void;

  constructor(hls: Hls) {
    this.hls = hls;
    this.log = logger.log.bind(logger, `[info]:`);
    this.warn = logger.warn.bind(logger, `[warning]:`);
    this.error = logger.error.bind(logger, `[error]:`);
    this.registerListeners();
  }

  private registerListeners() {
    const hls = this.hls;
    hls.on(Events.ERROR, this.onError, this);
    hls.on(Events.MANIFEST_LOADING, this.onManifestLoading, this);
    hls.on(Events.LEVEL_UPDATED, this.onLevelUpdated, this);
  }

  private unregisterListeners() {
    const hls = this.hls;
    if (!hls) {
      return;
    }
    hls.off(Events.ERROR, this.onError, this);
    hls.off(Events.ERROR, this.onErrorOut, this);
    hls.off(Events.MANIFEST_LOADING, this.onManifestLoading, this);
    hls.off(Events.LEVEL_UPDATED, this.onLevelUpdated, this);
  }

  destroy() {
    this.unregisterListeners();
    // @ts-ignore
    this.hls = null;
    this.penalizedRenditions = {};
  }

  startLoad(startPosition: number): void {}

  stopLoad(): void {
    this.playlistError = 0;
  }

  private getVariantLevelIndex(frag: Fragment | undefined): number {
    return frag?.type === PlaylistLevelType.MAIN
      ? frag.level
      : this.hls.loadLevel;
  }

  private onManifestLoading() {
    this.playlistError = 0;
    this.penalizedRenditions = {};
  }

  private onLevelUpdated() {
    this.playlistError = 0;
  }

  private onError(event: Events.ERROR, data: ErrorData) {
    if (data.fatal) {
      return;
    }
    const hls = this.hls;
    const context = data.context;

    switch (data.details) {
      case ErrorDetails.FRAG_LOAD_ERROR:
      case ErrorDetails.FRAG_LOAD_TIMEOUT:
      case ErrorDetails.KEY_LOAD_ERROR:
      case ErrorDetails.KEY_LOAD_TIMEOUT:
        data.errorAction = this.getFragRetryOrSwitchAction(data);
        return;
      case ErrorDetails.FRAG_GAP:
      case ErrorDetails.FRAG_PARSING_ERROR:
      case ErrorDetails.FRAG_DECRYPT_ERROR: {
        // Switch level if possible, otherwise allow retry count to reach max error retries
        data.errorAction = this.getFragRetryOrSwitchAction(data);
        data.errorAction.action = NetworkErrorAction.SendAlternateToPenaltyBox;
        return;
      }
      case ErrorDetails.LEVEL_EMPTY_ERROR:
      case ErrorDetails.LEVEL_PARSING_ERROR:
        {
          // Only retry when empty and live
          const levelIndex =
            data.parent === PlaylistLevelType.MAIN
              ? (data.level as number)
              : hls.loadLevel;
          if (
            data.details === ErrorDetails.LEVEL_EMPTY_ERROR &&
            !!data.context?.levelDetails?.live
          ) {
            data.errorAction = this.getPlaylistRetryOrSwitchAction(
              data,
              levelIndex
            );
          } else {
            // Escalate to fatal if not retrying or switching
            data.levelRetry = false;
            data.errorAction = this.getLevelSwitchAction(data, levelIndex);
          }
        }
        return;
      case ErrorDetails.LEVEL_LOAD_ERROR:
      case ErrorDetails.LEVEL_LOAD_TIMEOUT:
        if (typeof context?.level === 'number') {
          data.errorAction = this.getPlaylistRetryOrSwitchAction(
            data,
            context.level
          );
        }
        return;
      case ErrorDetails.AUDIO_TRACK_LOAD_ERROR:
      case ErrorDetails.AUDIO_TRACK_LOAD_TIMEOUT:
      case ErrorDetails.SUBTITLE_LOAD_ERROR:
      case ErrorDetails.SUBTITLE_TRACK_LOAD_TIMEOUT:
        if (context) {
          const level = hls.levels[hls.loadLevel];
          if (
            level &&
            ((context.type === PlaylistContextType.AUDIO_TRACK &&
              context.groupId === level.audioGroupId) ||
              (context.type === PlaylistContextType.SUBTITLE_TRACK &&
                context.groupId === level.textGroupId))
          ) {
            // Perform Pathway switch or Redundant failover if possible for fastest recovery
            // otherwise allow playlist retry count to reach max error retries
            data.errorAction = this.getPlaylistRetryOrSwitchAction(
              data,
              hls.loadLevel
            );
            data.errorAction.action =
              NetworkErrorAction.SendAlternateToPenaltyBox;
            data.errorAction.flags =
              ErrorActionFlags.MoveAllAlternatesMatchingHost;
            return;
          }
        }
        return;
      case ErrorDetails.KEY_SYSTEM_STATUS_OUTPUT_RESTRICTED:
        {
          const level = hls.levels[hls.loadLevel];
          const restrictedHdcpLevel = level?.attrs['HDCP-LEVEL'];
          if (restrictedHdcpLevel) {
            data.errorAction = {
              action: NetworkErrorAction.SendAlternateToPenaltyBox,
              flags: ErrorActionFlags.MoveAllAlternatesMatchingHDCP,
              hdcpLevel: restrictedHdcpLevel,
            };
          }
        }
        return;
      case ErrorDetails.BUFFER_ADD_CODEC_ERROR:
      case ErrorDetails.REMUX_ALLOC_ERROR:
      case ErrorDetails.BUFFER_APPEND_ERROR:
        data.errorAction = this.getLevelSwitchAction(
          data,
          data.level ?? hls.loadLevel
        );
        return;
      case ErrorDetails.INTERNAL_EXCEPTION:
      case ErrorDetails.BUFFER_APPENDING_ERROR:
      case ErrorDetails.BUFFER_FULL_ERROR:
      case ErrorDetails.LEVEL_SWITCH_ERROR:
      case ErrorDetails.BUFFER_STALLED_ERROR:
      case ErrorDetails.BUFFER_SEEK_OVER_HOLE:
      case ErrorDetails.BUFFER_NUDGE_ON_STALL:
        data.errorAction = {
          action: NetworkErrorAction.DoNothing,
          flags: ErrorActionFlags.None,
        };
        return;
    }

    if (data.type === ErrorTypes.KEY_SYSTEM_ERROR) {
      const levelIndex = this.getVariantLevelIndex(data.frag);
      // Do not retry level. Escalate to fatal if switching levels fails.
      data.levelRetry = false;
      data.errorAction = this.getLevelSwitchAction(data, levelIndex);
      return;
    }
  }

  private getPlaylistRetryOrSwitchAction(
    data: ErrorData,
    levelIndex: number | null | undefined
  ): IErrorAction {
    const hls = this.hls;
    const retryConfig = getRetryConfig(hls.config.playlistLoadPolicy, data);
    const retryCount = this.playlistError++;
    const httpStatus = data.response?.code;
    const retry = shouldRetry(
      retryConfig,
      retryCount,
      isTimeoutError(data),
      httpStatus
    );
    if (retry) {
      return {
        action: NetworkErrorAction.RetryRequest,
        flags: ErrorActionFlags.None,
        retryConfig,
        retryCount,
      };
    }
    const errorAction = this.getLevelSwitchAction(data, levelIndex);
    if (retryConfig) {
      errorAction.retryConfig = retryConfig;
      errorAction.retryCount = retryCount;
    }
    return errorAction;
  }

  private getFragRetryOrSwitchAction(data: ErrorData): IErrorAction {
    const hls = this.hls;
    // Share fragment error count accross media options (main, audio, subs)
    // This allows for level based rendition switching when media option assets fail
    const variantLevelIndex = this.getVariantLevelIndex(data.frag);
    const level = hls.levels[variantLevelIndex];
    const { fragLoadPolicy, keyLoadPolicy } = hls.config;
    const retryConfig = getRetryConfig(
      data.details.startsWith('key') ? keyLoadPolicy : fragLoadPolicy,
      data
    );
    const fragmentErrors = hls.levels.reduce(
      (acc, level) => acc + level.fragmentError,
      0
    );
    // Switch levels when out of retried or level index out of bounds
    if (level) {
      if (data.details !== ErrorDetails.FRAG_GAP) {
        level.fragmentError++;
      }
      const httpStatus = data.response?.code;
      const retry = shouldRetry(
        retryConfig,
        fragmentErrors,
        isTimeoutError(data),
        httpStatus
      );
      if (retry) {
        return {
          action: NetworkErrorAction.RetryRequest,
          flags: ErrorActionFlags.None,
          retryConfig,
          retryCount: fragmentErrors,
        };
      }
    }
    // Reach max retry count, or Missing level reference
    // Switch to valid index
    const errorAction = this.getLevelSwitchAction(data, variantLevelIndex);
    // Add retry details to allow skipping of FRAG_PARSING_ERROR
    if (retryConfig) {
      errorAction.retryConfig = retryConfig;
      errorAction.retryCount = fragmentErrors;
    }
    return errorAction;
  }

  private getLevelSwitchAction(
    data: ErrorData,
    levelIndex: number | null | undefined
  ): IErrorAction {
    const hls = this.hls;
    if (levelIndex === null || levelIndex === undefined) {
      levelIndex = hls.loadLevel;
    }
    const level = this.hls.levels[levelIndex];
    if (level) {
      level.loadError++;
      if (hls.autoLevelEnabled) {
        // Search for next level to retry
        let nextLevel = -1;
        const levels = hls.levels;
        const fragErrorType = data.frag?.type;
        const { type: playlistErrorType, groupId: playlistErrorGroupId } =
          data.context ?? {};
        for (let i = levels.length; i--; ) {
          const candidate = (i + hls.loadLevel) % levels.length;
          if (
            candidate !== hls.loadLevel &&
            levels[candidate].loadError === 0
          ) {
            const levelCandidate = levels[candidate];
            // Skip level switch if GAP tag is found in next level at same position
            if (data.details === ErrorDetails.FRAG_GAP && data.frag) {
              const levelDetails = levels[candidate].details;
              if (levelDetails) {
                const fragCandidate = findFragmentByPTS(
                  data.frag,
                  levelDetails.fragments,
                  data.frag.start
                );
                if (fragCandidate?.gap) {
                  continue;
                }
              }
            } else if (
              (playlistErrorType === PlaylistContextType.AUDIO_TRACK &&
                playlistErrorGroupId === levelCandidate.audioGroupId) ||
              (playlistErrorType === PlaylistContextType.SUBTITLE_TRACK &&
                playlistErrorGroupId === levelCandidate.textGroupId)
            ) {
              // For audio/subs playlist errors find another group ID or fallthrough to redundant fail-over
              continue;
            } else if (
              (fragErrorType === PlaylistLevelType.AUDIO &&
                level.audioGroupId === levelCandidate.audioGroupId) ||
              (fragErrorType === PlaylistLevelType.SUBTITLE &&
                level.textGroupId === levelCandidate.textGroupId)
            ) {
              // For audio/subs frag errors find another group ID or fallthrough to redundant fail-over
              continue;
            }
            nextLevel = candidate;
            break;
          }
        }
        if (nextLevel > -1 && hls.loadLevel !== nextLevel) {
          data.levelRetry = true;
          this.playlistError = 0;
          return {
            action: NetworkErrorAction.SendAlternateToPenaltyBox,
            flags: ErrorActionFlags.None,
            nextAutoLevel: nextLevel,
          };
        }
      }
    }
    // No levels to switch / Manual level selection / Level not found
    // Resolve with Pathway switch, Redundant fail-over, or stay on lowest Level
    return {
      action: NetworkErrorAction.SendAlternateToPenaltyBox,
      flags: ErrorActionFlags.MoveAllAlternatesMatchingHost,
    };
  }

  public onErrorOut(event: Events.ERROR, data: ErrorData) {
    switch (data.errorAction?.action) {
      case NetworkErrorAction.DoNothing:
        break;
      case NetworkErrorAction.SendAlternateToPenaltyBox:
        this.sendAlternateToPenaltyBox(data);
        if (
          !data.errorAction.resolved &&
          data.details !== ErrorDetails.FRAG_GAP
        ) {
          data.fatal = true;
        }
        break;
      case NetworkErrorAction.RetryRequest:
        // handled by stream and playlist/level controllers
        break;
    }

    if (data.fatal) {
      this.hls.stopLoad();
      return;
    }
  }

  private sendAlternateToPenaltyBox(data: ErrorData) {
    const hls = this.hls;
    const errorAction = data.errorAction;
    if (!errorAction) {
      return;
    }
    const { flags, hdcpLevel, nextAutoLevel } = errorAction;

    switch (flags) {
      case ErrorActionFlags.None:
        this.switchLevel(data, nextAutoLevel);
        break;
      case ErrorActionFlags.MoveAllAlternatesMatchingHost:
        {
          // Handle Redundant Levels here. Pathway switching is handled by content-steering-controller
          if (!errorAction.resolved) {
            errorAction.resolved = this.redundantFailover(data);
          }
        }
        break;
      case ErrorActionFlags.MoveAllAlternatesMatchingHDCP:
        if (hdcpLevel) {
          hls.maxHdcpLevel = HdcpLevels[HdcpLevels.indexOf(hdcpLevel) - 1];
          errorAction.resolved = true;
        }
        this.warn(
          `Restricting playback to HDCP-LEVEL of "${hls.maxHdcpLevel}" or lower`
        );
        break;
    }
    // If not resolved by previous actions try to switch to next level
    if (!errorAction.resolved) {
      this.switchLevel(data, nextAutoLevel);
    }
  }

  private switchLevel(data: ErrorData, levelIndex: number | undefined) {
    if (levelIndex !== undefined && data.errorAction) {
      this.warn(`switching to level ${levelIndex} after ${data.details}`);
      this.hls.nextAutoLevel = levelIndex;
      data.errorAction.resolved = true;
      // Stream controller is responsible for this but won't switch on false start
      this.hls.nextLoadLevel = this.hls.nextAutoLevel;
    }
  }

  private redundantFailover(data: ErrorData): boolean {
    const { hls, penalizedRenditions } = this;
    const levelIndex: number =
      data.parent === PlaylistLevelType.MAIN
        ? (data.level as number) || 0
        : hls.loadLevel;
    const level = hls.levels[levelIndex];
    const redundantLevels = level.url.length;
    const errorUrlId = data.frag ? data.frag.urlId : level.urlId;
    if (level.urlId === errorUrlId && (!data.frag || level.details)) {
      this.penalizeRendition(level, data);
    }
    for (let i = 1; i < redundantLevels; i++) {
      const newUrlId = (errorUrlId + i) % redundantLevels;
      const penalizedRendition = penalizedRenditions[newUrlId];
      // Check if rendition is penalized and skip if it is a bad fit for failover
      if (
        !penalizedRendition ||
        checkExpired(penalizedRendition, data, penalizedRenditions[errorUrlId])
      ) {
        // delete penalizedRenditions[newUrlId];
        // Update the url id of all levels so that we stay on the same set of variants when level switching
        this.warn(
          `Switching to Redundant Stream ${newUrlId + 1}/${redundantLevels}: "${
            level.url[newUrlId]
          }" after ${data.details}`
        );
        this.playlistError = 0;
        hls.levels.forEach((lv) => {
          lv.urlId = newUrlId;
        });
        hls.nextLoadLevel = levelIndex;
        return true;
      }
    }
    return false;
  }

  private penalizeRendition(level: Level, data: ErrorData) {
    const { penalizedRenditions } = this;
    const penalizedRendition = penalizedRenditions[level.urlId] || {
      lastErrorPerfMs: 0,
      errors: [],
      details: undefined,
    };
    penalizedRendition.lastErrorPerfMs = performance.now();
    penalizedRendition.errors.push(data);
    penalizedRendition.details = level.details;
    penalizedRenditions[level.urlId] = penalizedRendition;
  }
}

function checkExpired(
  penalizedRendition: PenalizedRendition,
  data: ErrorData,
  currentPenaltyState: PenalizedRendition | undefined
): boolean {
  // Expire penalty for switching back to rendition after RENDITION_PENALTY_DURATION_MS
  if (
    performance.now() - penalizedRendition.lastErrorPerfMs >
    RENDITION_PENALTY_DURATION_MS
  ) {
    return true;
  }
  // Expire penalty on GAP tag error if rendition has no GAP at position (does not cover media tracks)
  const lastErrorDetails = penalizedRendition.details;
  if (data.details === ErrorDetails.FRAG_GAP && lastErrorDetails && data.frag) {
    const position = data.frag.start;
    const candidateFrag = findFragmentByPTS(
      null,
      lastErrorDetails.fragments,
      position
    );
    if (candidateFrag && !candidateFrag.gap) {
      return true;
    }
  }
  // Expire penalty if there are more errors in currentLevel than in penalizedRendition
  if (
    currentPenaltyState &&
    penalizedRendition.errors.length < currentPenaltyState.errors.length
  ) {
    const lastCandidateError =
      penalizedRendition.errors[penalizedRendition.errors.length - 1];
    if (
      lastErrorDetails &&
      lastCandidateError.frag &&
      data.frag &&
      Math.abs(lastCandidateError.frag.start - data.frag.start) >
        lastErrorDetails.targetduration * 3
    ) {
      return true;
    }
  }
  return false;
}
