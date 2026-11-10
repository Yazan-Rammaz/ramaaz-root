import type { AdminStage, LogLine } from "./schema";

/*
 * ⚠️ MOCK — a business admin's progress log as the frames show it, stage by
 * stage, so the design can be walked through end to end. The real log comes
 * from the backend, with real times; nothing here is computed.
 */

const SECOND_ROOT = "Yasser Omran";

const APPROVAL: LogLine[] = [
  { text: `Send Approval Request To Root Admin "${SECOND_ROOT}"`, at: "13:01" },
  { text: `Waiting Approval From Root Admin "${SECOND_ROOT}"`, at: "40 S" },
];
const APPROVED: LogLine[] = [
  { text: `Approved By Root Admin "${SECOND_ROOT}"`, at: "13:02" },
  { text: "Waiting Send Login Information To Business Admin", at: "2 M" },
];
const SENT: LogLine[] = [
  { text: 'Send Login Information To Business Admin "Whatsapp"', at: "13:04" },
  {
    text: "Waiting Business Admin Login",
    at: "1 S",
    sub: [
      { text: '"Sended Massage Show Here"' },
      { text: 'Waiting Delivered To Whatsapp "40 Ms"' },
      { text: 'Delivered To Whatsapp "13:05"' },
      { text: 'Waiting Read On Whatsapp "40 Ms"' },
      { text: 'Read "13:06" "13:07"' },
      { text: 'Waiting Visit Link "40 Ms"' },
      { text: 'Link Opened "13:06" "13:07"' },
      { text: 'Waiting Entered Privet Code "40 Ms"' },
      { text: 'Entered Privet Code "13:06" "13:07"' },
      { text: 'Waiting Sent Verification Code Whatsapp "40 Ms"' },
      { text: "Sent Verification Code" },
      { text: 'Waiting Delivered To Whatsapp "40 Ms"' },
      { text: 'Delivered To Whatsapp "13:05"' },
      { text: 'Waiting Read On Whatsapp "40 Ms"' },
      { text: 'Read "13:06"' },
      { text: 'Waiting Entered Verification Code "40 Ms"' },
      { text: 'Entered Verification Code "13:06"' },
      { text: 'Waiting Identity Verification "40 Ms"' },
      { text: 'Started Identity Verification ! "13:06"' },
      { text: 'Try Identity Verification ! "13:06"' },
      { text: 'Approved Identity Verification ! "13:06"' },
      { text: 'Waiting Agreement And Terms "40 Ms"' },
      { text: 'Agreement "40 Ms"' },
      { text: 'Waiting Set Pass Code "40 Ms"' },
      { text: 'Set Pass Code "40 Ms"' },
      { text: 'Logged In Successfully "13:06"' },
    ],
  },
];

/** Every line up to and including `stage`. */
export function stageLog(stage: AdminStage): LogLine[] {
  switch (stage) {
    case "approval":
      return APPROVAL;
    case "send":
      return [...APPROVAL, ...APPROVED];
    default:
      return [...APPROVAL, ...APPROVED, ...SENT];
  }
}

/** The totals under a finished sign-in (frame 32). */
export const LOGIN_DURATION = { full: "30 M", user: "20", system: "5", approval: "25" };
