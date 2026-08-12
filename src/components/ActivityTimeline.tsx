import { CalendarDays, ChevronLeft, ChevronRight, Pause, Play, RotateCcw, Sparkles } from "lucide-react";
import { activityKind, activityStatus, moduleName, t, type Locale } from "../i18n";
import type { ActivityProjection, ModuleHealth } from "../types";

interface ActivityTimelineProps {
  activity: ActivityProjection;
  modules: ModuleHealth[];
  locale: Locale;
  selectedDate: string;
  playing: boolean;
  onSelectedDate: (date: string) => void;
  onTogglePlayback: () => void;
  onSelectModule: (moduleId: string) => void;
}

export function ActivityTimeline({ activity, modules, locale, selectedDate, playing, onSelectedDate, onTogglePlayback, onSelectModule }: ActivityTimelineProps) {
  const selectedIndex = Math.max(0, activity.daily.findIndex((day) => day.date === selectedDate));
  const selectedDay = activity.daily[selectedIndex] ?? activity.daily.at(-1);
  const events = activity.events
    .filter((event) => event.local_date === selectedDay?.date)
    .sort((left, right) => right.occurred_at.localeCompare(left.occurred_at));
  const milestones = activity.milestones.filter((item) => item.local_date === selectedDay?.date);
  const latest = activity.daily.at(-1)?.date ?? "";

  function move(offset: number) {
    const index = Math.max(0, Math.min(activity.daily.length - 1, selectedIndex + offset));
    const day = activity.daily[index];
    if (day) onSelectedDate(day.date);
  }

  return (
    <section className="activity-timeline" aria-label={t(locale, "timeline.title")} data-testid="activity-timeline">
      <header>
        <div><CalendarDays size={17} /><span><small>{t(locale, "timeline.eyebrow")}</small><strong>{t(locale, "timeline.title")}</strong></span></div>
        <div className="timeline-commands">
          <button className="icon-button" onClick={() => move(-1)} disabled={selectedIndex <= 0} aria-label={t(locale, "timeline.previous")}><ChevronLeft size={16} /></button>
          <button className="icon-button" onClick={onTogglePlayback} aria-label={t(locale, playing ? "timeline.pause" : "timeline.play")}>{playing ? <Pause size={15} /> : <Play size={15} />}</button>
          <button className="icon-button" onClick={() => move(1)} disabled={selectedIndex >= activity.daily.length - 1} aria-label={t(locale, "timeline.next")}><ChevronRight size={16} /></button>
          <button className="timeline-now" onClick={() => onSelectedDate(latest)}><RotateCcw size={14} />{t(locale, "timeline.now")}</button>
        </div>
      </header>
      <div className="timeline-date-row">
        <strong>{selectedDay ? new Date(`${selectedDay.date}T12:00:00`).toLocaleDateString(locale, { month: "long", day: "numeric", weekday: "short" }) : "-"}</strong>
        <span>{t(locale, "timeline.event_count", { count: selectedDay?.total ?? 0 })}</span>
        {milestones.length > 0 && <em><Sparkles size={12} />{t(locale, "timeline.milestone_count", { count: milestones.length })}</em>}
      </div>
      <div className="timeline-days" role="list" aria-label={t(locale, "timeline.days")}>
        {activity.daily.map((day, index) => (
          <button
            key={day.date}
            role="listitem"
            className={day.date === selectedDay?.date ? "is-active" : ""}
            style={{ "--activity-level": Math.min(1, day.total / 8) } as React.CSSProperties}
            onClick={() => onSelectedDate(day.date)}
            aria-label={`${day.date}, ${t(locale, "timeline.event_count", { count: day.total })}`}
          >
            <i /><span>{index % 5 === 0 || index === activity.daily.length - 1 ? new Date(`${day.date}T12:00:00`).getDate() : ""}</span>
          </button>
        ))}
      </div>
      <div className="timeline-modules">
        {modules.map((module) => {
          const count = selectedDay?.module_counts[module.id] ?? 0;
          return (
            <button key={module.id} className={count ? "is-active" : ""} disabled={!count} onClick={() => onSelectModule(module.id)}>
              <i data-status={module.health.status} /><span>{moduleName(locale, module.id, module.name)}</span><strong>{count}</strong>
            </button>
          );
        })}
      </div>
      <div className="timeline-event-list">
        {events.length ? events.slice(0, 7).map((event) => (
          <button key={event.id} onClick={() => onSelectModule(event.module_id)}>
            <time>{new Date(event.occurred_at).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })}</time>
            <span><strong>{activityKind(locale, event.kind)}</strong><small>{event.summary}</small></span>
            <em>{activityStatus(locale, event.status)}</em>
          </button>
        )) : <p>{t(locale, "timeline.no_activity")}</p>}
      </div>
      <footer>{t(locale, "timeline.privacy")}</footer>
    </section>
  );
}
