// Copyright 2023 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import * as TraceEngine from '../../models/trace/trace.js';
import type * as PerfUI from '../../ui/legacy/components/perf_ui/perf_ui.js';
import * as SDK from '../../core/sdk/sdk.js';
import type * as TimelineModel from '../../models/timeline_model/timeline_model.js';
import {
  type TimelineFlameChartEntry,
  EntryType,
  InstantEventVisibleDurationMs,
} from './TimelineFlameChartDataProvider.js';
import {TimingsTrackAppender} from './TimingsTrackAppender.js';
import {InteractionsTrackAppender} from './InteractionsTrackAppender.js';
import {GPUTrackAppender} from './GPUTrackAppender.js';
import {LayoutShiftsTrackAppender} from './LayoutShiftsTrackAppender.js';

export type HighlightedEntryInfo = {
  title: string,
  formattedTime: string,
  warning?: string,
};

/**
 * Track appenders add the data of each track into the timeline flame
 * chart. Each track appender also implements functions tha allow the
 * canvas renderer to gather more information about an event in a track,
 * like its display name or color.
 *
 * At the moment, tracks in the timeline flame chart are appended in
 * two locations: in the TimelineFlameChartDataProvider and in the track
 * appenders exported by this module. As part of the work to use a new
 * trace parsing engine, a track appender will be defined with this API
 * for each of the tracks in the timeline. With this implementation in
 * place its counterpart in the TimelineFlameChartDataProvider can be
 * removed. This processes of doing this for a track is referred to as
 * "migrating the track" to the new system.
 *
 * The migration implementation will result beneficial among other
 * things because the complexity of rendering the details of each track
 * is distributed among multiple standalone modules.
 * Read more at go/rpp-flamechart-arch
 */

export interface TrackAppender {
  /**
   * The unique name given to the track appender.
   */
  appenderName: TrackAppenderName;

  /**
   * Appends into the flame chart data the data corresponding to a track.
   * @param level the horizontal level of the flame chart events where the
   * track's events will start being appended.
   * @param expanded wether the track should be rendered expanded.
   * @returns the first available level to append more data after having
   * appended the track's events.
   */
  appendTrackAtLevel(level: number, expanded?: boolean): number;
  /**
   * Returns the color an event is shown with in the timeline.
   */
  colorForEvent(event: TraceEngine.Types.TraceEvents.TraceEventData): string;
  /**
   * Returns the title an event is shown with in the timeline.
   */
  titleForEvent(event: TraceEngine.Types.TraceEvents.TraceEventData): string;
  /**
   * Returns the info shown when an event in the timeline is hovered.
   */
  highlightedEntryInfo(event: TraceEngine.Types.TraceEvents.TraceEventData): HighlightedEntryInfo;
}

export const TrackNames = ['Timings', 'Interactions', 'GPU', 'LayoutShifts'] as const;
export type TrackAppenderName = typeof TrackNames[number];

export class CompatibilityTracksAppender {
  #trackForLevel = new Map<number, TrackAppender>();
  #trackForGroup = new Map<PerfUI.FlameChart.Group, TrackAppender>();
  #eventsForTrack = new Map<TrackAppenderName, TraceEngine.Types.TraceEvents.TraceEventData[]>();
  #trackEventsForTreeview = new Map<TrackAppenderName, TraceEngine.Types.TraceEvents.TraceEventData[]>();
  #flameChartData: PerfUI.FlameChart.FlameChartTimelineData;
  #traceParsedData: TraceEngine.TraceModel.PartialTraceParseDataDuringMigration;
  #entryData: TimelineFlameChartEntry[];
  #allTrackAppenders: TrackAppender[] = [];
  #visibleTrackNames: Set<TrackAppenderName> = new Set([...TrackNames]);

  // TODO(crbug.com/1416533)
  // These are used only for compatibility with the legacy flame chart
  // architecture of the panel. Once all tracks have been migrated to
  // use the new engine and flame chart architecture, the reference can
  // be removed.
  #legacyTimelineModel: TimelineModel.TimelineModel.TimelineModelImpl;
  #legacyEntryTypeByLevel: EntryType[];
  #timingsTrackAppender: TimingsTrackAppender;
  #interactionsTrackAppender: InteractionsTrackAppender;
  #gpuTrackAppender: GPUTrackAppender;
  #layoutShiftsTrackAppender: LayoutShiftsTrackAppender;

  /**
   * @param flameChartData the data used by the flame chart renderer on
   * which the track data will be appended.
   * @param traceParsedData the trace parsing engines output.
   * @param entryData the array containing all event to be rendered in
   * the flamechart.
   * @param legacyEntryTypeByLevel an array containing the type of
   * each entry in the entryData array. Indexed by the position the
   * corresponding entry occupies in the entryData array. This reference
   * is needed only for compatibility with the legacy flamechart
   * architecture and should be removed once all tracks use the new
   * system.
   */
  constructor(
      flameChartData: PerfUI.FlameChart.FlameChartTimelineData,
      traceParsedData: TraceEngine.TraceModel.PartialTraceParseDataDuringMigration,
      entryData: TimelineFlameChartEntry[], legacyEntryTypeByLevel: EntryType[],
      legacyTimelineModel: TimelineModel.TimelineModel.TimelineModelImpl) {
    this.#flameChartData = flameChartData;
    this.#traceParsedData = traceParsedData;
    this.#entryData = entryData;
    this.#legacyEntryTypeByLevel = legacyEntryTypeByLevel;
    this.#legacyTimelineModel = legacyTimelineModel;

    this.#timingsTrackAppender =
        new TimingsTrackAppender(this, this.#flameChartData, this.#traceParsedData, this.#legacyEntryTypeByLevel);
    this.#allTrackAppenders.push(this.#timingsTrackAppender);

    this.#interactionsTrackAppender =
        new InteractionsTrackAppender(this, this.#flameChartData, this.#traceParsedData, this.#legacyEntryTypeByLevel);
    this.#allTrackAppenders.push(this.#interactionsTrackAppender);

    this.#gpuTrackAppender = new GPUTrackAppender(this, this.#traceParsedData, this.#legacyEntryTypeByLevel);
    this.#allTrackAppenders.push(this.#gpuTrackAppender);

    // Layout Shifts track in OPP was called the "Experience" track even though
    // all it shows are layout shifts.
    this.#layoutShiftsTrackAppender =
        new LayoutShiftsTrackAppender(this, this.#flameChartData, this.#traceParsedData, this.#legacyEntryTypeByLevel);
    this.#allTrackAppenders.push(this.#layoutShiftsTrackAppender);
  }

  /**
   * Given a trace event returns instantiates a legacy SDK.Event. This should
   * be used for compatibility purposes only.
   */
  getLegacyEvent(event: TraceEngine.Types.TraceEvents.TraceEventData): SDK.TracingModel.Event|null {
    const process = this.#legacyTimelineModel.tracingModel()?.getProcessById(event.pid);
    const thread = process?.threadById(event.tid);
    if (!thread) {
      return null;
    }
    return SDK.TracingModel.PayloadEvent.fromPayload(event as unknown as SDK.TracingManager.EventPayload, thread);
  }

  timingsTrackAppender(): TimingsTrackAppender {
    return this.#timingsTrackAppender;
  }

  interactionsTrackAppender(): InteractionsTrackAppender {
    return this.#interactionsTrackAppender;
  }

  gpuTrackAppender(): GPUTrackAppender {
    return this.#gpuTrackAppender;
  }

  layoutShiftsTrackAppender(): LayoutShiftsTrackAppender {
    return this.#layoutShiftsTrackAppender;
  }

  eventsInTrack(trackAppenderName: TrackAppenderName): TraceEngine.Types.TraceEvents.TraceEventData[] {
    const cachedData = this.#eventsForTrack.get(trackAppenderName);
    if (cachedData) {
      return cachedData;
    }

    // Calculate the levels occupied by a track.
    let trackStartLevel = null;
    let trackEndLevel = null;
    for (const [level, track] of this.#trackForLevel) {
      if (track.appenderName !== trackAppenderName) {
        continue;
      }
      if (trackStartLevel === null) {
        trackStartLevel = level;
      }
      trackEndLevel = level;
    }

    if (trackStartLevel === null || trackEndLevel === null) {
      throw new Error(`Could not find events for track: ${trackAppenderName}`);
    }
    const entryLevels = this.#flameChartData.entryLevels;
    const events = [];
    for (let i = 0; i < entryLevels.length; i++) {
      if (trackStartLevel <= entryLevels[i] && entryLevels[i] <= trackEndLevel) {
        events.push(this.#entryData[i] as TraceEngine.Types.TraceEvents.TraceEventData);
      }
    }
    events.sort((a, b) => a.ts - b.ts);
    this.#eventsForTrack.set(trackAppenderName, events);
    return events;
  }

  /**
   * Determines if the given events, which are assumed to be ordered can
   * be organized into tree structures.
   * This condition is met if there is *not* a pair of async events
   * e1 and e2 where:
   *
   * e1.startTime <= e2.startTime && e1.endTime > e2.startTime && e1.endTime > e2.endTime.
   * or, graphically:
   * |------- e1 ------|
   *   |------- e2 --------|
   *
   * Because a parent-child relationship cannot be made from the example
   * above, a tree cannot be made from the set of events.
   *
   * Note that this will also return true if multiple trees can be
   * built, for example if none of the events overlap with each other.
   */
  canBuildTreesFromEvents(events: readonly TraceEngine.Types.TraceEvents.TraceEventData[]): boolean {
    const stack: TraceEngine.Types.TraceEvents.TraceEventData[] = [];
    for (const event of events) {
      const startTime = event.ts;
      const endTime = event.ts + (event.dur || 0);
      let parent = stack.at(-1);
      if (parent === undefined) {
        stack.push(event);
        continue;
      }
      let parentEndTime = parent.ts + (parent.dur || 0);
      // Discard events that are not parents for this event. The parent
      // is one whose end time is after this event start time.
      while (stack.length && startTime >= parentEndTime) {
        stack.pop();
        parent = stack.at(-1);

        if (parent === undefined) {
          break;
        }
        parentEndTime = parent.ts + (parent.dur || 0);
      }
      if (stack.length && endTime > parentEndTime) {
        // If such an event exists but its end time is before this
        // event's end time, then a tree cannot be made using this
        // events.
        return false;
      }
      stack.push(event);
    }
    return true;
  }

  /**
   * Gets the events to be shown in the tree views of the details pane
   * (Bottom-up, Call tree, etc.). These are the events from the track
   * that can be arranged in a tree shape.
   */
  eventsForTreeView(trackAppenderName: TrackAppenderName): TraceEngine.Types.TraceEvents.TraceEventData[] {
    const cachedData = this.#trackEventsForTreeview.get(trackAppenderName);
    if (cachedData) {
      return cachedData;
    }

    let trackEvents = this.eventsInTrack(trackAppenderName);
    if (!this.canBuildTreesFromEvents(trackEvents)) {
      // Some tracks can include both async and sync events. When this
      // happens, we use all events for the tree views if a trees can be
      // built from both sync and async events. If this is not possible,
      // async events are filtered out and only sync events are used
      // (it's assumed a tree can always be built using a tracks sync
      // events).
      trackEvents = trackEvents.filter(e => !TraceEngine.Types.TraceEvents.isAsyncPhase(e.ph));
    }
    this.#trackEventsForTreeview.set(trackAppenderName, trackEvents);
    return trackEvents;
  }

  /**
   * Caches the track appender that owns a flame chart group. FlameChart
   * groups are created for each track in the timeline. When an user
   * selects a track in the UI, the track's group is passed to the model
   * layer to inform about the selection.
   */
  registerTrackForGroup(group: PerfUI.FlameChart.Group, appender: TrackAppender): void {
    this.#flameChartData.groups.push(group);
    this.#trackForGroup.set(group, appender);
  }

  /**
   * Given a FlameChart group, gets the events to be shown in the tree
   * views if that group was registered by the appender system.
   */
  groupEventsForTreeView(group: PerfUI.FlameChart.Group): TraceEngine.Types.TraceEvents.TraceEventData[]|null {
    const track = this.#trackForGroup.get(group);
    if (!track) {
      return null;
    }
    return this.eventsForTreeView(track.appenderName);
  }

  /**
   * Caches the track appender that owns a level. An appender takes
   * ownership of a level when it appends data to it.
   * The cache is useful to determine what appender should handle a
   * query from the flame chart renderer when an event's feature (like
   * style, title, etc.) is needed.
   */
  registerTrackForLevel(level: number, appender: TrackAppender): void {
    // TODO(crbug.com/1442454) Figure out how to avoid the circular calls.
    this.#trackForLevel.set(level, appender);
  }

  /**
   * Adds an event to the flame chart data at a defined level.
   * @param event the event to be appended,
   * @param level the level to append the event,
   * @param appender the track which the event belongs to.
   * @returns the index of the event in all events to be rendered in the flamechart.
   */
  appendEventAtLevel(event: TraceEngine.Types.TraceEvents.TraceEventData, level: number, appender: TrackAppender):
      number {
    // TODO(crbug.com/1442454) Figure out how to avoid the circular calls.
    this.#trackForLevel.set(level, appender);

    const index = this.#entryData.length;
    this.#entryData.push(event);
    this.#legacyEntryTypeByLevel[level] = EntryType.TrackAppender;
    this.#flameChartData.entryLevels[index] = level;
    this.#flameChartData.entryStartTimes[index] = TraceEngine.Helpers.Timing.microSecondsToMilliseconds(event.ts);
    const msDuration = event.dur ||
        TraceEngine.Helpers.Timing.millisecondsToMicroseconds(
            InstantEventVisibleDurationMs as TraceEngine.Types.Timing.MilliSeconds);
    this.#flameChartData.entryTotalTimes[index] = TraceEngine.Helpers.Timing.microSecondsToMilliseconds(msDuration);
    return index;
  }

  /**
   * Gets the all track appenders that have been set to be visible.
   */
  allVisibleTrackAppenders(): TrackAppender[] {
    return this.#allTrackAppenders.filter(track => this.#visibleTrackNames.has(track.appenderName));
  }

  /**
   * Sets the visible tracks internally
   * @param visibleTracks set with the names of the visible track
   * appenders. If undefined, all tracks are set to be visible.
   */
  setVisibleTracks(visibleTracks?: Set<TrackAppenderName>): void {
    if (!visibleTracks) {
      this.#visibleTrackNames = new Set([...TrackNames]);
      return;
    }
    this.#visibleTrackNames = visibleTracks;
  }

  /**
   * Returns the color an event is shown with in the timeline.
   */
  colorForEvent(event: TraceEngine.Types.TraceEvents.TraceEventData, level: number): string {
    const track = this.#trackForLevel.get(level);
    if (!track) {
      throw new Error('Track not found for level');
    }
    return track.colorForEvent(event);
  }
  /**
   * Returns the title an event is shown with in the timeline.
   */
  titleForEvent(event: TraceEngine.Types.TraceEvents.TraceEventData, level: number): string {
    const track = this.#trackForLevel.get(level);
    if (!track) {
      throw new Error('Track not found for level');
    }
    return track.titleForEvent(event);
  }
  /**
   * Returns the info shown when an event in the timeline is hovered.
   */
  highlightedEntryInfo(event: TraceEngine.Types.TraceEvents.TraceEventData, level: number): HighlightedEntryInfo {
    const track = this.#trackForLevel.get(level);
    if (!track) {
      throw new Error('Track not found for level');
    }
    return track.highlightedEntryInfo(event);
  }
}
