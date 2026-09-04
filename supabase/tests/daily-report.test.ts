import { previousArgentinaCalendarDate, utcWindow } from "../functions/_shared/daily-report.ts";
import { assertEquals } from "./assert.ts";

Deno.test("el resumen respeta el día calendario de Argentina", () => {
  assertEquals(previousArgentinaCalendarDate(new Date("2026-09-03T10:59:00Z")), "2026-09-02");
  assertEquals(previousArgentinaCalendarDate(new Date("2026-09-03T02:30:00Z")), "2026-09-01");
  assertEquals(utcWindow("2026-09-02"), {
    start: "2026-09-02T03:00:00.000Z",
    end: "2026-09-03T03:00:00.000Z",
  });
});
