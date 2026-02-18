import bcrypt from "bcryptjs";
import { Types } from "mongoose";
import { connectToMongoDB } from "./mongodb";
import {
  Announcement,
  AnnouncementRead,
  BreakLog,
  CalendarEvent,
  ChatMessage,
  FormSubmission,
  LeaveApplication,
  Meeting,
  MeetingParticipant,
  Notification,
  Payslip,
  Project,
  ProjectAssignment,
  ProjectTask,
  TimeEntry,
  User,
  EmployeeDocument,
} from "./models";

type UpsertUserInput = {
  openId: string;
  name?: string | null;
  email?: string | null;
  loginMethod?: string | null;
  role?: "user" | "admin";
  employeeId?: string | null;
  password?: string | null;
  avatar?: string | null;
  department?: string | null;
  position?: string | null;
  lastSignedIn?: Date;
};

const PRIORITY_RANK: Record<string, number> = {
  high: 3,
  medium: 2,
  low: 1,
};

async function requireDb() {
  const connected = await connectToMongoDB();
  if (!connected) {
    throw new Error("Database not available");
  }
}

async function optionalDb(): Promise<boolean> {
  return connectToMongoDB();
}

function toObjectId(id: string) {
  if (!Types.ObjectId.isValid(id)) {
    throw new Error("Invalid id");
  }
  return new Types.ObjectId(id);
}

function normalizeValue(value: unknown): unknown {
  if (value instanceof Types.ObjectId) {
    return value.toString();
  }
  if (value instanceof Date) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(normalizeValue);
  }
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      result[key] = normalizeValue(entry);
    }
    return result;
  }
  return value;
}

function normalizeDoc<T extends { _id?: Types.ObjectId }>(
  doc: T | null | undefined
) {
  if (!doc) return undefined;
  const raw = typeof (doc as any).toObject === "function" ? (doc as any).toObject() : doc;
  const { _id, __v, ...rest } = raw as any;
  const normalized = normalizeValue(rest) as Record<string, unknown>;
  return {
    id: _id ? _id.toString() : undefined,
    ...normalized,
  };
}

function normalizeDocs<T extends { _id?: Types.ObjectId }>(docs: T[]) {
  return docs.map(doc => normalizeDoc(doc)).filter(Boolean);
}

function sanitizeUser(user: any) {
  if (!user) return user;
  const { password, ...rest } = user;
  return rest;
}

export async function upsertUser(user: UpsertUserInput): Promise<void> {
  await requireDb();
  if (!user.openId) {
    throw new Error("User openId is required for upsert");
  }

  const payload: Record<string, unknown> = {
    openId: user.openId,
  };

  const fields: Array<keyof UpsertUserInput> = [
    "name",
    "email",
    "loginMethod",
    "role",
    "employeeId",
    "password",
    "avatar",
    "department",
    "position",
    "lastSignedIn",
  ];

  for (const field of fields) {
    const value = user[field];
    if (value !== undefined) {
      payload[field] = value ?? null;
    }
  }

  if (!payload.lastSignedIn) {
    payload.lastSignedIn = new Date();
  }

  await User.updateOne(
    { openId: user.openId },
    { $set: payload, $setOnInsert: { openId: user.openId } },
    { upsert: true }
  );
}

export async function getUserByOpenId(openId: string) {
  if (!(await optionalDb())) return undefined;
  const user = await User.findOne({ openId }).lean();
  return sanitizeUser(normalizeDoc(user));
}

export async function getUserByEmployeeIdAndPassword(
  employeeId: string,
  password: string
) {
  if (!(await optionalDb())) return undefined;
  const user = await User.findOne({ employeeId }).lean();
  if (!user) return undefined;

  const hashed = user.password || "";
  const isPasswordValid = await bcrypt.compare(password, hashed).catch(() => false);
  const isPlainMatch = hashed.length === 0 ? false : hashed === password;

  if (!isPasswordValid && !isPlainMatch) return undefined;
  return sanitizeUser(normalizeDoc(user));
}

export async function verifyUserPassword(userId: string, password: string) {
  if (!(await optionalDb())) return false;
  const user = await User.findById(toObjectId(userId)).lean();
  if (!user) return false;

  const hashed = user.password || "";
  const isPasswordValid = await bcrypt.compare(password, hashed).catch(() => false);
  const isPlainMatch = hashed.length === 0 ? false : hashed === password;

  return isPasswordValid || isPlainMatch;
}

export async function updateUserPassword(userId: string, newPassword: string) {
  await requireDb();
  const hashed = await bcrypt.hash(newPassword, 10);
  await User.findByIdAndUpdate(toObjectId(userId), { password: hashed });
}

export async function createEmployee(input: {
  name: string;
  email: string;
  employeeId: string;
  password: string;
  department?: string;
  position?: string;
  role?: "user" | "admin";
}) {
  await requireDb();
  const hashed = await bcrypt.hash(input.password, 10);
  const openId = `emp-${input.employeeId.toLowerCase()}`;
  const created = await User.create({
    openId,
    name: input.name,
    email: input.email,
    loginMethod: "custom",
    role: input.role || "user",
    employeeId: input.employeeId,
    password: hashed,
    department: input.department,
    position: input.position,
    lastSignedIn: new Date(0),
  });
  return sanitizeUser(normalizeDoc(created));
}

export async function updateEmployee(userId: string, updates: {
  name?: string;
  email?: string;
  employeeId?: string;
  password?: string;
  department?: string;
  position?: string;
}) {
  await requireDb();
  const payload: Record<string, unknown> = {};
  if (updates.name !== undefined) payload.name = updates.name;
  if (updates.email !== undefined) payload.email = updates.email;
  if (updates.employeeId !== undefined) payload.employeeId = updates.employeeId;
  if (updates.department !== undefined) payload.department = updates.department;
  if (updates.position !== undefined) payload.position = updates.position;
  if (updates.password) {
    payload.password = await bcrypt.hash(updates.password, 10);
  }
  await User.findByIdAndUpdate(toObjectId(userId), payload);
  return getUserById(userId);
}

export async function upsertEmployeeDocument(input: {
  userId: string;
  documentType:
    | "offer_letter"
    | "contract"
    | "id_proof"
    | "id_proof_front"
    | "id_proof_back"
    | "policy_acknowledgment"
    | "other";
  title: string;
  documentUrl: string;
  uploadedBy: string;
}) {
  await requireDb();
  await EmployeeDocument.findOneAndUpdate(
    { userId: toObjectId(input.userId), documentType: input.documentType },
    {
      $set: {
        title: input.title,
        documentUrl: input.documentUrl,
        uploadedBy: toObjectId(input.uploadedBy),
      },
    },
    { upsert: true }
  );
}

export async function getUserById(id: string) {
  if (!(await optionalDb())) return undefined;
  const user = await User.findById(toObjectId(id)).lean();
  return sanitizeUser(normalizeDoc(user));
}

export async function updateUserAvatar(userId: string, avatar: string) {
  await requireDb();
  await User.findByIdAndUpdate(toObjectId(userId), { avatar });
}

export async function createTimeEntry(entry: {
  userId: string;
  timeIn: Date;
  status: "active" | "completed" | "early_out";
  notes?: string;
}) {
  await requireDb();
  const created = await TimeEntry.create({
    ...entry,
    userId: toObjectId(entry.userId),
  });
  return normalizeDoc(created);
}

export async function getActiveTimeEntry(userId: string) {
  if (!(await optionalDb())) return undefined;
  const entry = await TimeEntry.findOne({
    userId: toObjectId(userId),
    status: "active",
  })
    .sort({ createdAt: -1 })
    .lean();
  return normalizeDoc(entry);
}

export async function updateTimeEntry(id: string, updates: Record<string, unknown>) {
  await requireDb();
  await TimeEntry.findByIdAndUpdate(toObjectId(id), updates);
}

export async function getTimeEntriesByDateRange(
  userId: string,
  startDate: Date,
  endDate: Date
) {
  if (!(await optionalDb())) return [];
  const entries = await TimeEntry.find({
    userId: toObjectId(userId),
    timeIn: { $gte: startDate, $lte: endDate },
  })
    .sort({ timeIn: -1 })
    .lean();
  return normalizeDocs(entries);
}

export async function createBreakLog(breakLog: {
  timeEntryId: string;
  userId: string;
  breakStart: Date;
}) {
  await requireDb();
  const created = await BreakLog.create({
    ...breakLog,
    timeEntryId: toObjectId(breakLog.timeEntryId),
    userId: toObjectId(breakLog.userId),
  });
  return normalizeDoc(created);
}

export async function getActiveBreak(timeEntryId: string) {
  if (!(await optionalDb())) return undefined;
  const result = await BreakLog.findOne({
    timeEntryId: toObjectId(timeEntryId),
    $or: [{ breakEnd: { $exists: false } }, { breakEnd: null }],
  }).lean();
  return normalizeDoc(result);
}

export async function updateBreakLog(id: string, updates: Record<string, unknown>) {
  await requireDb();
  await BreakLog.findByIdAndUpdate(toObjectId(id), updates);
}

export async function getBreakLogsByTimeEntry(timeEntryId: string) {
  if (!(await optionalDb())) return [];
  const logs = await BreakLog.find({ timeEntryId: toObjectId(timeEntryId) })
    .sort({ breakStart: -1 })
    .lean();
  return normalizeDocs(logs);
}

export async function createLeaveApplication(leave: {
  userId: string;
  leaveType: "sick" | "casual" | "annual" | "unpaid" | "other";
  startDate: Date;
  endDate: Date;
  reason: string;
}) {
  await requireDb();
  const created = await LeaveApplication.create({
    ...leave,
    userId: toObjectId(leave.userId),
  });
  return normalizeDoc(created);
}

export async function getLeaveApplicationsByUser(userId: string) {
  if (!(await optionalDb())) return [];
  const leaves = await LeaveApplication.find({ userId: toObjectId(userId) })
    .sort({ createdAt: -1 })
    .lean();
  return normalizeDocs(leaves);
}

export async function createFormSubmission(form: {
  userId: string;
  formType: "resignation" | "leave" | "grievance" | "feedback";
  subject: string;
  content: string;
  priority?: "low" | "medium" | "high";
}) {
  await requireDb();
  const created = await FormSubmission.create({
    ...form,
    userId: toObjectId(form.userId),
  });
  return normalizeDoc(created);
}

export async function getFormSubmissionsByUser(userId: string) {
  if (!(await optionalDb())) return [];
  const submissions = await FormSubmission.find({ userId: toObjectId(userId) })
    .sort({ createdAt: -1 })
    .lean();
  return normalizeDocs(submissions);
}

export async function createChatMessage(message: {
  senderId: string;
  recipientId?: string;
  message: string;
}) {
  await requireDb();
  const created = await ChatMessage.create({
    senderId: toObjectId(message.senderId),
    recipientId: message.recipientId ? toObjectId(message.recipientId) : undefined,
    message: message.message,
  });
  return normalizeDoc(created);
}

export async function getChatMessages(userId: string, limit: number = 50) {
  if (!(await optionalDb())) return [];
  const userObjectId = toObjectId(userId);
  const messages = await ChatMessage.find({
    $or: [
      { senderId: userObjectId },
      { recipientId: userObjectId },
      { recipientId: { $exists: false } },
      { recipientId: null },
    ],
  })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
  return normalizeDocs(messages);
}

export async function markMessageAsRead(id: string) {
  await requireDb();
  await ChatMessage.findByIdAndUpdate(toObjectId(id), { isRead: true });
}

export async function getLatestPayslip(userId: string) {
  if (!(await optionalDb())) return undefined;
  const payslip = await Payslip.findOne({ userId: toObjectId(userId) })
    .sort({ year: -1, month: -1 })
    .lean();
  return normalizeDoc(payslip);
}

export async function getActiveAnnouncements() {
  if (!(await optionalDb())) return [];
  const now = new Date();
  const announcements = await Announcement.find({
    isActive: true,
    $or: [{ expiresAt: { $exists: false } }, { expiresAt: null }, { expiresAt: { $gt: now } }],
  })
    .sort({ createdAt: -1 })
    .lean();

  const normalized = normalizeDocs(announcements);
  return normalized.sort((a: any, b: any) => {
    const rankDiff = (PRIORITY_RANK[b.priority] || 0) - (PRIORITY_RANK[a.priority] || 0);
    if (rankDiff !== 0) return rankDiff;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });
}

export async function getAllUsers() {
  if (!(await optionalDb())) return [];
  const users = await User.find().lean();
  return normalizeDocs(users).map(sanitizeUser);
}

export async function getUserProjects(userId: string) {
  if (!(await optionalDb())) return [];
  const assignments = await ProjectAssignment.find({ userId: toObjectId(userId) })
    .populate("projectId")
    .lean();

  return assignments
    .map((assignment: any) => {
      if (!assignment.projectId) return undefined;
      const project = assignment.projectId as any;
      return normalizeDoc({ ...project, role: assignment.role });
    })
    .filter(Boolean);
}

export async function getProjectTasks(projectId: string, userId: string) {
  if (!(await optionalDb())) return [];
  const tasks = await ProjectTask.find({
    projectId: toObjectId(projectId),
    userId: toObjectId(userId),
  }).lean();
  return normalizeDocs(tasks);
}

export async function createProject(project: Record<string, unknown>) {
  await requireDb();
  const created = await Project.create({
    ...project,
    createdBy: project.createdBy ? toObjectId(project.createdBy as string) : undefined,
  });
  const normalized = normalizeDoc(created);
  return normalized?.id as string;
}

export async function assignUserToProject(projectId: string, userId: string) {
  await requireDb();
  await ProjectAssignment.create({
    projectId: toObjectId(projectId),
    userId: toObjectId(userId),
    role: "member",
  });
}

export async function createProjectTask(task: Record<string, unknown>) {
  await requireDb();
  await ProjectTask.create({
    ...task,
    projectId: task.projectId ? toObjectId(task.projectId as string) : undefined,
    userId: task.userId ? toObjectId(task.userId as string) : undefined,
    timeEntryId: task.timeEntryId ? toObjectId(task.timeEntryId as string) : undefined,
  });
}

export async function updateProjectTask(id: string, updates: Record<string, unknown>) {
  await requireDb();
  await ProjectTask.findByIdAndUpdate(toObjectId(id), updates);
}

export async function getProjectStats(userId: string) {
  if (!(await optionalDb())) {
    return { totalAssigned: 0, activeProjects: 0, completedTasks: 0 };
  }

  const userObjectId = toObjectId(userId);
  const assignments = await ProjectAssignment.find({ userId: userObjectId })
    .select("projectId")
    .lean();
  const projectIds = assignments.map((assignment: any) => assignment.projectId);

  const [totalAssigned, activeProjects, completedTasks] = await Promise.all([
    ProjectAssignment.countDocuments({ userId: userObjectId }),
    projectIds.length > 0
      ? Project.countDocuments({ _id: { $in: projectIds }, status: "active" })
      : Promise.resolve(0),
    ProjectTask.countDocuments({ userId: userObjectId, status: "completed" }),
  ]);

  return {
    totalAssigned,
    activeProjects,
    completedTasks,
  };
}

export async function createNotification(notification: {
  userId: string;
  type: string;
  title: string;
  message: string;
  priority?: "low" | "medium" | "high";
  relatedId?: string;
  relatedType?: string;
}) {
  await requireDb();
  await Notification.create({
    ...notification,
    userId: toObjectId(notification.userId),
    relatedId: notification.relatedId ? toObjectId(notification.relatedId) : undefined,
  });
}

export async function getNotifications(userId: string) {
  if (!(await optionalDb())) return [];
  const list = await Notification.find({ userId: toObjectId(userId) })
    .sort({ createdAt: -1 })
    .lean();
  return normalizeDocs(list);
}

export async function getUnreadNotificationCount(userId: string) {
  if (!(await optionalDb())) return 0;
  return Notification.countDocuments({
    userId: toObjectId(userId),
    isRead: false,
  });
}

export async function markNotificationAsRead(notificationId: string, userId: string) {
  await requireDb();
  await Notification.findOneAndUpdate(
    { _id: toObjectId(notificationId), userId: toObjectId(userId) },
    { isRead: true }
  );
}

export async function markAllNotificationsAsRead(userId: string) {
  await requireDb();
  await Notification.updateMany({ userId: toObjectId(userId) }, { isRead: true });
}

export async function deleteNotification(notificationId: string, userId: string) {
  await requireDb();
  await Notification.findOneAndDelete({
    _id: toObjectId(notificationId),
    userId: toObjectId(userId),
  });
}

export async function markAnnouncementAsRead(announcementId: string, userId: string) {
  await requireDb();
  const exists = await AnnouncementRead.findOne({
    announcementId: toObjectId(announcementId),
    userId: toObjectId(userId),
  }).lean();

  if (!exists) {
    await AnnouncementRead.create({
      announcementId: toObjectId(announcementId),
      userId: toObjectId(userId),
    });
  }
}

export async function getAnnouncementReadStatus(announcementId: string, userId: string) {
  if (!(await optionalDb())) return false;
  const existing = await AnnouncementRead.findOne({
    announcementId: toObjectId(announcementId),
    userId: toObjectId(userId),
  }).lean();
  return Boolean(existing);
}

export async function createMeeting(data: {
  title: string;
  description?: string;
  agenda?: string;
  startTime: Date;
  endTime: Date;
  location?: string;
  meetingLink?: string;
  organizerId: string;
}) {
  await requireDb();
  const created = await Meeting.create({
    ...data,
    organizerId: toObjectId(data.organizerId),
  });
  return normalizeDoc(created);
}

export async function getMeetingById(id: string) {
  if (!(await optionalDb())) return null;
  const meeting = await Meeting.findById(toObjectId(id)).lean();
  return normalizeDoc(meeting) ?? null;
}

export async function getMeetingsByUserId(userId: string) {
  if (!(await optionalDb())) return [];
  const userObjectId = toObjectId(userId);
  const organizerMeetings = await Meeting.find({ organizerId: userObjectId }).lean();

  const participantMeetings = await MeetingParticipant.find({ userId: userObjectId })
    .populate("meetingId")
    .lean();

  const combined: Record<string, any> = {};

  organizerMeetings.forEach(meeting => {
    const normalized = normalizeDoc(meeting);
    if (normalized?.id) combined[normalized.id] = normalized;
  });

  participantMeetings.forEach((participant: any) => {
    if (!participant.meetingId) return;
    const normalized = normalizeDoc(participant.meetingId as any);
    if (normalized?.id) combined[normalized.id] = normalized;
  });

  return Object.values(combined).sort((a: any, b: any) => {
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });
}

export async function getMeetingsByDateRange(startDate: Date, endDate: Date) {
  if (!(await optionalDb())) return [];
  const meetings = await Meeting.find({
    startTime: { $gte: startDate, $lte: endDate },
  })
    .sort({ startTime: 1 })
    .lean();
  return normalizeDocs(meetings);
}

export async function updateMeeting(id: string, data: Record<string, unknown>) {
  await requireDb();
  await Meeting.findByIdAndUpdate(toObjectId(id), data);
  return getMeetingById(id);
}

export async function deleteMeeting(id: string) {
  await requireDb();
  const meetingId = toObjectId(id);
  await MeetingParticipant.deleteMany({ meetingId });
  await Meeting.findByIdAndDelete(meetingId);
  return true;
}

export async function addMeetingParticipant(data: {
  meetingId: string;
  userId: string;
  responseStatus?: "pending" | "accepted" | "declined" | "tentative";
}) {
  await requireDb();
  return MeetingParticipant.create({
    meetingId: toObjectId(data.meetingId),
    userId: toObjectId(data.userId),
    responseStatus: data.responseStatus || "pending",
  });
}

export async function getMeetingParticipants(meetingId: string) {
  if (!(await optionalDb())) return [];
  const participants = await MeetingParticipant.find({ meetingId: toObjectId(meetingId) })
    .populate("userId")
    .lean();
  return participants.map((participant: any) => {
    const normalizedParticipant = normalizeDoc(participant);
    const normalizedUser = participant.userId ? normalizeDoc(participant.userId as any) : null;
    return { participant: normalizedParticipant, user: normalizedUser };
  });
}

export async function updateParticipantResponse(
  meetingId: string,
  userId: string,
  responseStatus: string
) {
  await requireDb();
  await MeetingParticipant.findOneAndUpdate(
    {
      meetingId: toObjectId(meetingId),
      userId: toObjectId(userId),
    },
    { responseStatus }
  );
  return true;
}

export async function removeMeetingParticipant(meetingId: string, userId: string) {
  await requireDb();
  await MeetingParticipant.findOneAndDelete({
    meetingId: toObjectId(meetingId),
    userId: toObjectId(userId),
  });
  return true;
}

export async function createCalendarEvent(data: {
  userId: string;
  title: string;
  description?: string;
  startTime: Date;
  endTime: Date;
  eventType: "reminder" | "personal" | "deadline" | "holiday";
  isAllDay?: boolean;
}) {
  await requireDb();
  const created = await CalendarEvent.create({
    ...data,
    userId: toObjectId(data.userId),
    isAllDay: Boolean(data.isAllDay),
  });
  return normalizeDoc(created);
}

export async function getCalendarEventById(id: string) {
  if (!(await optionalDb())) return null;
  const event = await CalendarEvent.findById(toObjectId(id)).lean();
  return normalizeDoc(event) ?? null;
}

export async function getCalendarEventsByUserId(userId: string) {
  if (!(await optionalDb())) return [];
  const events = await CalendarEvent.find({ userId: toObjectId(userId) })
    .sort({ startTime: -1 })
    .lean();
  return normalizeDocs(events);
}

export async function getCalendarEventsByDateRange(
  userId: string,
  startDate: Date,
  endDate: Date
) {
  if (!(await optionalDb())) return [];
  const events = await CalendarEvent.find({
    userId: toObjectId(userId),
    startTime: { $gte: startDate, $lte: endDate },
  })
    .sort({ startTime: 1 })
    .lean();
  return normalizeDocs(events);
}

export async function updateCalendarEvent(id: string, data: Record<string, unknown>) {
  await requireDb();
  await CalendarEvent.findByIdAndUpdate(toObjectId(id), data);
  return getCalendarEventById(id);
}

export async function deleteCalendarEvent(id: string) {
  await requireDb();
  await CalendarEvent.findByIdAndDelete(toObjectId(id));
  return true;
}
