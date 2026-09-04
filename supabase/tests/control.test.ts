import {
  authorizedControlCommand,
  normalizePhoneInput,
  parseControlCommand,
} from "../functions/_shared/control.ts";
import { assertEquals } from "./assert.ts";

Deno.test("normaliza y reconoce el comando exacto de pausa", () => {
  assertEquals(parseControlCommand("PAUSAR +54 9 11 5247-1902"), {
    type: "contact_mode",
    phone: "5491152471902",
    humanMode: true,
    verb: "pausar",
  });
});

Deno.test("reconoce variantes de comandos administrativos", () => {
  assertEquals(parseControlCommand("TOMAR (011) 5247.1902"), {
    type: "contact_mode",
    phone: "5491152471902",
    humanMode: true,
    verb: "tomar",
  });
  assertEquals(parseControlCommand("LIBERAR +54 9 11 5247-1902"), {
    type: "contact_mode",
    phone: "5491152471902",
    humanMode: false,
    verb: "liberar",
  });
  assertEquals(parseControlCommand("REACTIVAR BOT"), { type: "global_mode", enabled: true });
  assertEquals(parseControlCommand("PAUSAR TODO"), { type: "global_mode", enabled: false });
  assertEquals(parseControlCommand("ESTADO BOT"), { type: "status" });
  assertEquals(normalizePhoneInput("+54 (9) 11-5247.1902"), "5491152471902");
  assertEquals(parseControlCommand("PAUSAR 12"), null);
});

Deno.test("rechaza comandos enviados por números no autorizados", () => {
  const internal = new Set(["5491111111111"]);
  assertEquals(authorizedControlCommand("5491122222222", "PAUSAR +54 9 11 5247-1902", internal), null);
  assertEquals(
    authorizedControlCommand("5491111111111", "PAUSAR +54 9 11 5247-1902", internal)?.type,
    "contact_mode",
  );
});
