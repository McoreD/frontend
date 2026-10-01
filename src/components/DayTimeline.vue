<template>
  <aside
    class="day-timeline"
    :class="$mq === 'sm' ? 'day-timeline-sm' : null"
    :aria-label="$t('Timeline')"
  >
    <div class="day-timeline-header">
      <button
        class="button button-flat button-icon"
        :title="$t('Previous day')"
        @click="shiftDay(-1)"
      >
        <ChevronLeftIcon size="1x" :aria-label="$t('Previous day')" />
      </button>
      <strong class="day-timeline-title">{{ day.format("dddd, LL") }}</strong>
      <button
        class="button button-flat button-icon"
        :title="$t('Next day')"
        :disabled="isToday"
        @click="shiftDay(1)"
      >
        <ChevronRightIcon size="1x" :aria-label="$t('Next day')" />
      </button>
      <button
        class="button button-flat button-icon"
        :title="$t('Close timeline')"
        @click="close"
      >
        <XIcon size="1x" :aria-label="$t('Close timeline')" />
      </button>
    </div>

    <div class="day-timeline-calendar">
      <div class="calendar-nav">
        <button
          class="button button-flat button-icon"
          :title="$t('Previous month')"
          @click="shiftMonth(-1)"
        >
          <ChevronLeftIcon size="1x" :aria-label="$t('Previous month')" />
        </button>
        <span>{{ month.format("MMMM YYYY") }}</span>
        <button
          class="button button-flat button-icon"
          :title="$t('Next month')"
          :disabled="month.isSame(today, 'month')"
          @click="shiftMonth(1)"
        >
          <ChevronRightIcon size="1x" :aria-label="$t('Next month')" />
        </button>
      </div>
      <div class="calendar-grid" role="grid">
        <span
          v-for="weekday in weekdays"
          :key="weekday"
          class="calendar-weekday"
          role="columnheader"
        >
          {{ weekday }}
        </span>
        <button
          v-for="cell in calendarCells"
          :key="cell.key"
          class="calendar-day"
          :class="{
            'calendar-day-outside': !cell.inMonth,
            'calendar-day-selected': cell.selected,
            'calendar-day-today': cell.today,
          }"
          :disabled="cell.future"
          :title="
            cell.count
              ? $t('{count} locations', { count: cell.count })
              : $t('No locations')
          "
          @click="selectDay(cell.date)"
        >
          {{ cell.date.date() }}
          <span
            class="calendar-dot"
            :style="{ opacity: cell.count ? dotOpacity(cell.count) : 0 }"
          ></span>
        </button>
      </div>
    </div>

    <p v-if="!Object.keys(devices).length" class="day-timeline-hint">
      {{ $t("Loading...") }}
    </p>
    <p v-else-if="!target" class="day-timeline-hint">
      {{ $t("Select a user and device to see their timeline.") }}
    </p>
    <p v-else-if="segments.length === 0" class="day-timeline-hint">
      {{ $t("No locations on this day.") }}
    </p>
    <ol v-else class="day-timeline-segments">
      <li
        v-for="(segment, i) in segments"
        :key="i"
        :class="`segment segment-${segment.type}`"
      >
        <button class="segment-button" @click="focus(segment)">
          <time class="segment-time">{{ formatTime(segment.start) }}</time>
          <span class="segment-marker" aria-hidden="true">
            <MapPinIcon v-if="segment.type === 'stay'" size="1x" />
            <NavigationIcon v-else size="0.8x" />
          </span>
          <span class="segment-body">
            <template v-if="segment.type === 'stay'">
              <strong>
                {{ segment.place || formatCoordinate(segment.center) }}
              </strong>
              <small v-if="segment.endIsLast && segment.end === segment.start">
                {{ $t("From {time}", { time: formatTime(segment.start) }) }}
              </small>
              <small v-else>
                {{ formatTime(segment.start) }} –
                {{ formatTime(segment.end) }}
                · {{ humanReadableDuration(segment.end - segment.start) }}
              </small>
            </template>
            <template v-else>
              <span>{{ $t("Moving") }}</span>
              <small>
                {{ humanReadableDistance(Math.round(segment.distance)) }}
                · {{ humanReadableDuration(segment.end - segment.start) }}
              </small>
            </template>
          </span>
        </button>
      </li>
    </ol>
  </aside>
</template>

<script>
import moment from "moment";
import { mapActions, mapMutations, mapState } from "vuex";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  MapPinIcon,
  NavigationIcon,
  XIcon,
} from "vue-feather-icons";

import * as api from "@/api";
import { DATE_TIME_FORMAT } from "@/constants";
import { log } from "@/logging";
import * as types from "@/store/mutation-types";
import { buildTimeline, countByDay, humanReadableDuration } from "@/timeline";
import { humanReadableDistance } from "@/util";

const toUtc = (m) => m.clone().utc().format(DATE_TIME_FORMAT);

export default {
  components: {
    ChevronLeftIcon,
    ChevronRightIcon,
    MapPinIcon,
    NavigationIcon,
    XIcon,
  },
  data() {
    return {
      month: moment().startOf("month"),
      monthCounts: {},
      monthAbortController: null,
      today: moment().startOf("day"),
    };
  },
  computed: {
    ...mapState([
      "devices",
      "locationHistory",
      "selectedDevice",
      "selectedUser",
      "startDateTime",
      "endDateTime",
    ]),
    /** The single user/device the timeline is about, or null if ambiguous. */
    target() {
      if (this.selectedUser && this.selectedDevice) {
        return { user: this.selectedUser, device: this.selectedDevice };
      }
      const all = Object.keys(this.devices).flatMap((user) =>
        (this.devices[user] || []).map((device) => ({ user, device }))
      );
      if (this.selectedUser) {
        const own = all.filter((d) => d.user === this.selectedUser);
        return own.length === 1 ? own[0] : null;
      }
      return all.length === 1 ? all[0] : null;
    },
    day() {
      return moment
        .utc(this.startDateTime, DATE_TIME_FORMAT)
        .local()
        .startOf("day");
    },
    isToday() {
      return this.day.isSame(this.today, "day");
    },
    dayLocations() {
      if (!this.target) return [];
      const { user, device } = this.target;
      const locations =
        (this.locationHistory[user] && this.locationHistory[user][device]) ||
        [];
      const start = this.day.unix();
      const end = this.day.clone().endOf("day").unix();
      return locations.filter((l) => l.tst >= start && l.tst <= end);
    },
    segments() {
      return buildTimeline(this.dayLocations, this.$config.timeline);
    },
    weekdays() {
      const first = moment().startOf("week");
      return [...Array(7).keys()].map((i) =>
        first.clone().add(i, "days").format("dd")
      );
    },
    calendarCells() {
      const start = this.month.clone().startOf("week");
      const end = this.month.clone().endOf("month").endOf("week");
      const cells = [];
      for (
        let d = start.clone();
        d.isSameOrBefore(end, "day");
        d.add(1, "day")
      ) {
        const key = d.format("YYYY-MM-DD");
        cells.push({
          key,
          date: d.clone(),
          count: this.monthCounts[key] || 0,
          inMonth: d.isSame(this.month, "month"),
          selected: d.isSame(this.day, "day"),
          today: d.isSame(this.today, "day"),
          future: d.isAfter(this.today, "day"),
        });
      }
      return cells;
    },
    maxCount() {
      return Math.max(1, ...Object.values(this.monthCounts));
    },
  },
  watch: {
    target() {
      this.loadMonth();
    },
    month() {
      this.loadMonth();
    },
    day(day) {
      if (!day.isSame(this.month, "month")) {
        this.month = day.clone().startOf("month");
      }
    },
  },
  created() {
    // The timeline shows one day. Narrow a longer range down to its last day.
    const end = moment.utc(this.endDateTime, DATE_TIME_FORMAT).local();
    if (!end.isSame(this.day, "day")) {
      this.selectDay(moment.min(end, moment()));
    }
    this.month = this.day.clone().startOf("month");
    this.loadMonth();
  },
  beforeDestroy() {
    if (this.monthAbortController) this.monthAbortController.abort();
  },
  methods: {
    ...mapActions(["setDateTimeRange"]),
    ...mapMutations({
      setTimelineOpen: types.SET_TIMELINE_OPEN,
      setTimelineHighlight: types.SET_TIMELINE_HIGHLIGHT,
    }),
    humanReadableDistance,
    humanReadableDuration,
    formatTime(tst) {
      return moment.unix(tst).format("LT");
    },
    formatCoordinate({ lat, lng }) {
      return `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
    },
    dotOpacity(count) {
      return 0.35 + 0.65 * Math.min(1, count / this.maxCount);
    },
    selectDay(date) {
      const day = moment(date).startOf("day");
      this.setTimelineHighlight(null);
      this.setDateTimeRange({
        start: toUtc(day),
        end: toUtc(day.clone().endOf("day").milliseconds(0)),
      });
    },
    shiftDay(delta) {
      this.selectDay(this.day.clone().add(delta, "days"));
    },
    shiftMonth(delta) {
      this.month = this.month.clone().add(delta, "months");
    },
    close() {
      this.setTimelineOpen(false);
    },
    focus(segment) {
      const latLngs =
        segment.type === "stay" ? [segment.center] : segment.latLngs;
      this.setTimelineHighlight(latLngs);
      this.$root.$emit("fitBounds", latLngs);
    },
    /** Load the selected month once to mark days that have data. */
    async loadMonth() {
      if (this.monthAbortController) this.monthAbortController.abort();
      this.monthCounts = {};
      if (!this.target) return;
      const controller = new AbortController();
      this.monthAbortController = controller;
      const { user, device } = this.target;
      try {
        const locations = await api.getUserDeviceLocationHistory(
          user,
          device,
          toUtc(this.month),
          toUtc(this.month.clone().endOf("month").milliseconds(0)),
          { signal: controller.signal }
        );
        if (!controller.signal.aborted)
          this.monthCounts = countByDay(locations);
      } catch (error) {
        if (!controller.signal.aborted) log("TIMELINE", error);
      }
    },
  },
};
</script>

<style lang="scss" scoped>
.day-timeline {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  z-index: 1000;
  width: 360px;
  max-width: 100%;
  overflow-y: auto;
  color: var(--color-text);
  background: var(--color-background);
  box-shadow: -2px 0 12px rgba(0, 0, 0, 0.15);

  &.day-timeline-sm {
    top: 50%;
    left: 0;
    width: auto;
    box-shadow: 0 -2px 12px rgba(0, 0, 0, 0.15);
  }
}

.day-timeline-header {
  position: sticky;
  top: 0;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 10px 12px;
  background: var(--color-background);
  border-bottom: 1px solid var(--color-separator);
}

.day-timeline-title {
  flex: 1;
  text-align: center;
}

.button.button-flat.button-icon {
  color: var(--color-text);

  &:hover:not(:disabled),
  &:focus:not(:disabled) {
    background: var(--color-separator);
  }

  &:disabled {
    opacity: 0.3;
    cursor: default;
  }
}

.day-timeline-calendar {
  padding: 8px 16px 12px;
  border-bottom: 1px solid var(--color-separator);
}

.calendar-nav {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-weight: bold;
}

.calendar-grid {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 2px;
  text-align: center;
}

.calendar-weekday {
  padding: 4px 0;
  font-size: 12px;
  opacity: 0.6;
}

.calendar-day {
  position: relative;
  padding: 6px 0 10px;
  font: inherit;
  font-size: 14px;
  color: inherit;
  background: none;
  border: 0;
  border-radius: 6px;
  cursor: pointer;

  &:hover:not(:disabled) {
    background: var(--color-separator);
  }

  &:disabled {
    opacity: 0.3;
    cursor: default;
  }

  &.calendar-day-outside {
    opacity: 0.45;
  }

  &.calendar-day-today {
    font-weight: bold;
  }

  &.calendar-day-selected {
    color: var(--color-primary-text);
    background: var(--color-primary);

    .calendar-dot {
      background: var(--color-primary-text);
    }
  }
}

.calendar-dot {
  position: absolute;
  bottom: 3px;
  left: 50%;
  width: 5px;
  height: 5px;
  margin-left: -2.5px;
  border-radius: 50%;
  background: var(--color-primary);
}

.day-timeline-hint {
  margin: 0;
  padding: 24px 16px;
  text-align: center;
  opacity: 0.7;
}

.day-timeline-segments {
  margin: 0;
  padding: 8px 0 16px;
  list-style: none;
}

.segment-button {
  display: grid;
  grid-template-columns: 64px 24px 1fr;
  align-items: start;
  width: 100%;
  padding: 0 16px;
  font: inherit;
  color: inherit;
  text-align: left;
  background: none;
  border: 0;
  cursor: pointer;

  &:hover,
  &:focus-visible {
    background: var(--color-separator);
  }
}

.segment-time {
  padding: 10px 0;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  opacity: 0.7;
}

.segment-marker {
  position: relative;
  display: flex;
  justify-content: center;
  align-self: stretch;
  padding-top: 11px;
  color: var(--color-primary);

  // The vertical line connecting the day
  &::before {
    content: "";
    position: absolute;
    top: 0;
    bottom: 0;
    left: 50%;
    border-left: 2px solid var(--color-separator);
  }

  .feather {
    position: relative;
    background: var(--color-background);
  }
}

.segment-move .segment-marker::before {
  border-left-style: dashed;
}

.segment-body {
  display: flex;
  flex-direction: column;
  padding: 8px 0 10px 8px;
  min-width: 0;

  strong {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  small {
    opacity: 0.7;
  }
}

.segment-move .segment-body {
  font-size: 14px;
  opacity: 0.85;
}
</style>
