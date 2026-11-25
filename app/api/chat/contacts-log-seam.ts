// The server seam for the manual contact log in Ask Coop's outreach lists (RET-05, plan
// knowledge/tasks/2026-11-10-customer-contact-log-stage5.md). It lives outside src/chat on purpose: src/chat may not import
// the data layer (test/chat-architecture.test.ts). It reuses the Customers tab's own read, so the chat counts exactly what a
// signed-in owner sees there. Read only: the email, channel and time of each logged contact (RET-07), never its note or author. Null = unavailable.
import {getManualContactEmails} from '@/src/customer-contacts-data';

export const loadManualContacts = getManualContactEmails;
