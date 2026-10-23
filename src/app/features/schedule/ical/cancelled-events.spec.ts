import { getRelevantEventsForCalendarIntegrationFromIcal } from './get-relevant-events-from-ical';

describe('cancelled calendar events', () => {
  const read = (
    events: string,
  ): ReturnType<typeof getRelevantEventsForCalendarIntegrationFromIcal> =>
    getRelevantEventsForCalendarIntegrationFromIcal(
      `BEGIN:VCALENDAR
VERSION:2.0
${events}
END:VCALENDAR`,
      'calendar',
      Date.parse('2026-10-24T00:00:00Z'),
      Date.parse('2026-10-25T00:00:00Z'),
    );
  it('omits cancelled standalone events while retaining confirmed events', async () => {
    const events = await read(`BEGIN:VEVENT
UID:cancelled
DTSTART:20261024T120000Z
DTEND:20261024T130000Z
SUMMARY:Cancelled
STATUS:CANCELLED
END:VEVENT
BEGIN:VEVENT
UID:active
DTSTART:20261024T140000Z
DTEND:20261024T150000Z
SUMMARY:Active
STATUS:CONFIRMED
END:VEVENT`);
    expect(events.map((event) => event.id)).toEqual(['active']);
  });
  it('omits a cancelled series including detached overrides', async () => {
    expect(
      await read(`BEGIN:VEVENT
UID:series
DTSTART:20261023T120000Z
DTEND:20261023T130000Z
RRULE:FREQ=DAILY;COUNT=3
SUMMARY:Cancelled series
STATUS:CANCELLED
END:VEVENT
BEGIN:VEVENT
UID:series
RECURRENCE-ID:20261024T120000Z
DTSTART:20261024T140000Z
DTEND:20261024T150000Z
SUMMARY:Old override
END:VEVENT`),
    ).toEqual([]);
  });
});
