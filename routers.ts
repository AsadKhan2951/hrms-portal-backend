import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, protectedProcedure, router } from "./_core/trpc";
import { z } from "zod";
import * as db from "./db";
import { TRPCError } from "@trpc/server";
import { createSessionToken, setSessionCookie } from "./_core/auth";

export const appRouter = router({
  system: systemRouter,
  
  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),
    
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return {
        success: true,
      } as const;
    }),

    // Custom login for Hassan and Talha
    customLogin: publicProcedure
      .input(z.object({
        employeeId: z.string(),
        password: z.string(),
      }))
      .mutation(async ({ input, ctx }) => {
        const user = await db.getUserByEmployeeIdAndPassword(input.employeeId, input.password);
        
        if (!user) {
          throw new TRPCError({
            code: "UNAUTHORIZED",
            message: "Invalid employee ID or password",
          });
        }

        const maxAgeMs = 30 * 24 * 60 * 60 * 1000;
        const token = await createSessionToken(user.id, { expiresInMs: maxAgeMs });
        setSessionCookie(ctx.res, ctx.req, token, maxAgeMs);

        return {
          success: true,
          user: {
            id: user.id,
            name: user.name,
            email: user.email,
            employeeId: user.employeeId,
            department: user.department,
            position: user.position,
          },
        };
      }),

    // Update user avatar
    updateAvatar: protectedProcedure
      .input(z.object({
        avatar: z.string(),
      }))
      .mutation(async ({ input, ctx }) => {
        await db.updateUserAvatar(ctx.user.id, input.avatar);
        return { success: true };
      }),
  }),

  timeTracking: router({
    // Clock in
    clockIn: protectedProcedure.mutation(async ({ ctx }) => {
      const activeEntry = await db.getActiveTimeEntry(ctx.user.id);
      
      if (activeEntry) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "You are already clocked in",
        });
      }

      await db.createTimeEntry({
        userId: ctx.user.id,
        timeIn: new Date(),
        status: "active",
      });

      return { success: true };
    }),

    // Clock out
    clockOut: protectedProcedure
      .input(z.object({
        notes: z.string().optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        const activeEntry = await db.getActiveTimeEntry(ctx.user.id);
        
        if (!activeEntry) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "No active time entry found",
          });
        }

        const timeOut = new Date();
        const timeIn = new Date(activeEntry.timeIn);
        const totalHours = (timeOut.getTime() - timeIn.getTime()) / (1000 * 60 * 60);
        
        const status = totalHours < 6.5 ? "early_out" : "completed";

        await db.updateTimeEntry(activeEntry.id, {
          timeOut,
          totalHours: Number(totalHours.toFixed(2)),
          status,
          notes: input.notes,
        });

        return { 
          success: true, 
          totalHours: parseFloat(totalHours.toFixed(2)),
          status,
        };
      }),

    // Get active time entry
    getActive: protectedProcedure.query(async ({ ctx }) => {
      const activeEntry = await db.getActiveTimeEntry(ctx.user.id);
      return activeEntry || null;
    }),

    // Start break
    startBreak: protectedProcedure.mutation(async ({ ctx }) => {
      const activeEntry = await db.getActiveTimeEntry(ctx.user.id);
      
      if (!activeEntry) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "No active time entry found",
        });
      }

      const activeBreak = await db.getActiveBreak(activeEntry.id);
      if (activeBreak) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Break already in progress",
        });
      }

      await db.createBreakLog({
        timeEntryId: activeEntry.id,
        userId: ctx.user.id,
        breakStart: new Date(),
      });

      return { success: true };
    }),

    // End break
    endBreak: protectedProcedure.mutation(async ({ ctx }) => {
      const activeEntry = await db.getActiveTimeEntry(ctx.user.id);
      
      if (!activeEntry) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "No active time entry found",
        });
      }

      const activeBreak = await db.getActiveBreak(activeEntry.id);
      if (!activeBreak) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "No active break found",
        });
      }

      const breakEnd = new Date();
      const breakStart = new Date(activeBreak.breakStart);
      const duration = Math.floor((breakEnd.getTime() - breakStart.getTime()) / (1000 * 60));

      await db.updateBreakLog(activeBreak.id, {
        breakEnd,
        duration,
      });

      return { success: true, duration };
    }),

    // Get break logs for current session
    getBreakLogs: protectedProcedure.query(async ({ ctx }) => {
      const activeEntry = await db.getActiveTimeEntry(ctx.user.id);
      
      if (!activeEntry) {
        return [];
      }

      return await db.getBreakLogsByTimeEntry(activeEntry.id);
    }),

    // Get attendance for date range
    getAttendance: protectedProcedure
      .input(z.object({
        startDate: z.date(),
        endDate: z.date(),
      }))
      .query(async ({ input, ctx }) => {
        return await db.getTimeEntriesByDateRange(ctx.user.id, input.startDate, input.endDate);
      }),
  }),

  leaves: router({
    // Submit leave application
    submit: protectedProcedure
      .input(z.object({
        leaveType: z.enum(["sick", "casual", "annual", "unpaid", "other"]),
        startDate: z.date(),
        endDate: z.date(),
        reason: z.string(),
      }))
      .mutation(async ({ input, ctx }) => {
        await db.createLeaveApplication({
          userId: ctx.user.id,
          ...input,
        });

        return { success: true };
      }),

    // Get user's leave applications
    getMyLeaves: protectedProcedure.query(async ({ ctx }) => {
      return await db.getLeaveApplicationsByUser(ctx.user.id);
    }),
  }),

  forms: router({
    // Submit form (resignation, grievance, feedback)
    submit: protectedProcedure
      .input(z.object({
        formType: z.enum(["resignation", "leave", "grievance", "feedback"]),
        subject: z.string(),
        content: z.string(),
        priority: z.enum(["low", "medium", "high"]).optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        await db.createFormSubmission({
          userId: ctx.user.id,
          ...input,
        });

        return { success: true };
      }),

    // Get user's form submissions
    getMyForms: protectedProcedure.query(async ({ ctx }) => {
      return await db.getFormSubmissionsByUser(ctx.user.id);
    }),
  }),

  chat: router({
    // Send message
    send: protectedProcedure
      .input(z.object({
        message: z.string(),
        recipientId: z.string().optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        await db.createChatMessage({
          senderId: ctx.user.id,
          recipientId: input.recipientId,
          message: input.message,
        });

        return { success: true };
      }),

    // Get messages
    getMessages: protectedProcedure
      .input(z.object({
        limit: z.number().optional(),
      }))
      .query(async ({ input, ctx }) => {
        const messages = await db.getChatMessages(ctx.user.id, input.limit);
        const users = await db.getAllUsers();
        
        return messages.map(msg => ({
          ...msg,
          sender: users.find(u => u.id === msg.senderId),
        }));
      }),

    // Mark message as read
    markRead: protectedProcedure
      .input(z.object({
        messageId: z.string(),
      }))
      .mutation(async ({ input }) => {
        await db.markMessageAsRead(input.messageId);
        return { success: true };
      }),
  }),

  dashboard: router({
    // Get payslip
    getPayslip: protectedProcedure.query(async ({ ctx }) => {
      const payslip = await db.getLatestPayslip(ctx.user.id);
      return payslip || null;
    }),

    // Get announcements
    getAnnouncements: protectedProcedure.query(async () => {
      const announcements = await db.getActiveAnnouncements();
      return announcements || [];
    }),

    // Get all users for chat
    getUsers: protectedProcedure.query(async () => {
      return await db.getAllUsers();
    }),
  }),

  projects: router({
    // Get user's projects
    getMyProjects: protectedProcedure.query(async ({ ctx }) => {
      return await db.getUserProjects(ctx.user.id);
    }),

    // Get project tasks
    getTasks: protectedProcedure
      .input(z.object({
        projectId: z.string(),
      }))
      .query(async ({ input, ctx }) => {
        return await db.getProjectTasks(input.projectId, ctx.user.id);
      }),

    // Create custom project (employee-created)
    createCustomProject: protectedProcedure
      .input(z.object({
        name: z.string(),
        description: z.string().optional(),
        priority: z.enum(["low", "medium", "high"]).optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        const projectId = await db.createProject({
          name: input.name,
          description: input.description,
          priority: input.priority || "medium",
          status: "active",
          source: "employee",
          createdBy: ctx.user.id,
        });

        // Auto-assign creator to the project
        await db.assignUserToProject(projectId, ctx.user.id);

        return { success: true, projectId };
      }),

    // Create task
    createTask: protectedProcedure
      .input(z.object({
        projectId: z.string(),
        title: z.string(),
        description: z.string().optional(),
        priority: z.enum(["low", "medium", "high"]).optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        await db.createProjectTask({
          projectId: input.projectId,
          userId: ctx.user.id,
          title: input.title,
          description: input.description,
          priority: input.priority || "medium",
        });

        return { success: true };
      }),

    // Update task
    updateTask: protectedProcedure
      .input(z.object({
        taskId: z.string(),
        status: z.enum(["todo", "in_progress", "completed", "blocked"]).optional(),
        title: z.string().optional(),
        description: z.string().optional(),
        priority: z.enum(["low", "medium", "high"]).optional(),
      }))
      .mutation(async ({ input }) => {
        const { taskId, ...updates } = input;
        
        const updateData: any = { ...updates };
        if (updates.status === "completed") {
          updateData.completedAt = new Date();
        }

        await db.updateProjectTask(taskId, updateData);
        return { success: true };
      }),

    // Get project stats
    getStats: protectedProcedure.query(async ({ ctx }) => {
      return await db.getProjectStats(ctx.user.id);
    }),
  }),

  notifications: router({
    // Get all notifications for current user
    getAll: protectedProcedure.query(async ({ ctx }) => {
      return await db.getNotifications(ctx.user.id);
    }),

    // Get unread count
    getUnreadCount: protectedProcedure.query(async ({ ctx }) => {
      return await db.getUnreadNotificationCount(ctx.user.id);
    }),

    // Mark notification as read
    markAsRead: protectedProcedure
      .input(z.object({ notificationId: z.string() }))
      .mutation(async ({ input, ctx }) => {
        await db.markNotificationAsRead(input.notificationId, ctx.user.id);
        return { success: true };
      }),

    // Mark all as read
    markAllAsRead: protectedProcedure.mutation(async ({ ctx }) => {
      await db.markAllNotificationsAsRead(ctx.user.id);
      return { success: true };
    }),

    // Delete notification
    delete: protectedProcedure
      .input(z.object({ notificationId: z.string() }))
      .mutation(async ({ input, ctx }) => {
        await db.deleteNotification(input.notificationId, ctx.user.id);
        return { success: true };
      }),

     // Create notification (used internally by other procedures)
    create: protectedProcedure
      .input(z.object({
        userId: z.string(),
        type: z.enum(["project_assigned", "attendance_issue", "hours_shortfall", "leave_approved", "leave_rejected", "announcement", "system_alert"]),
        title: z.string(),
        message: z.string(),
        priority: z.enum(["low", "medium", "high"]).default("medium"),
        relatedId: z.string().optional(),
        relatedType: z.string().optional(),
      }))
      .mutation(async ({ input }) => {
        await db.createNotification(input);
        return { success: true };
      }),
  }),

  // ==================== MEETINGS ====================
  meetings: router({
    // Create a new meeting
    create: protectedProcedure
      .input(z.object({
        title: z.string(),
        description: z.string().optional(),
        agenda: z.string().optional(),
        startTime: z.date(),
        endTime: z.date(),
        location: z.string().optional(),
        meetingLink: z.string().optional(),
        participantIds: z.array(z.string()),
      }))
      .mutation(async ({ input, ctx }) => {
        const { participantIds, ...meetingData } = input;
        
        // Create meeting
        const meeting = await db.createMeeting({
          ...meetingData,
          organizerId: ctx.user.id,
        });
        
        if (!meeting) throw new Error("Failed to create meeting");
        
        // Add participants
        for (const userId of participantIds) {
          await db.addMeetingParticipant({
            meetingId: meeting.id,
            userId,
            responseStatus: "pending",
          });
        }
        
        return meeting;
      }),

    // Get user's meetings
    getMyMeetings: protectedProcedure.query(async ({ ctx }) => {
      const meetings = await db.getMeetingsByUserId(ctx.user.id);
      return meetings;
    }),

    // Get meeting by ID with participants
    getById: protectedProcedure
      .input(z.object({ id: z.string() }))
      .query(async ({ input }) => {
        const meeting = await db.getMeetingById(input.id);
        if (!meeting) throw new TRPCError({ code: "NOT_FOUND" });
        
        const participants = await db.getMeetingParticipants(input.id);
        return { meeting, participants };
      }),

    // Update meeting response
    updateResponse: protectedProcedure
      .input(z.object({
        meetingId: z.string(),
        responseStatus: z.enum(["accepted", "declined", "tentative"]),
      }))
      .mutation(async ({ input, ctx }) => {
        await db.updateParticipantResponse(input.meetingId, ctx.user.id, input.responseStatus);
        return { success: true };
      }),

    // Update meeting details
    update: protectedProcedure
      .input(z.object({
        id: z.string(),
        title: z.string().optional(),
        description: z.string().optional(),
        agenda: z.string().optional(),
        startTime: z.date().optional(),
        endTime: z.date().optional(),
        location: z.string().optional(),
        meetingLink: z.string().optional(),
        status: z.enum(["scheduled", "in_progress", "completed", "cancelled"]).optional(),
      }))
      .mutation(async ({ input }) => {
        const { id, ...data } = input;
        await db.updateMeeting(id, data);
        return { success: true };
      }),

    // Add meeting minutes and action items
    addMinutes: protectedProcedure
      .input(z.object({
        meetingId: z.string(),
        meetingMinutes: z.string(),
        actionItems: z.string(),
      }))
      .mutation(async ({ input }) => {
        await db.updateMeeting(input.meetingId, {
          meetingMinutes: input.meetingMinutes,
          actionItems: input.actionItems,
          status: "completed",
        });
        return { success: true };
      }),

    // Delete meeting
    delete: protectedProcedure
      .input(z.object({ id: z.string() }))
      .mutation(async ({ input }) => {
        await db.deleteMeeting(input.id);
        return { success: true };
      }),
  }),

  // ==================== CALENDAR EVENTS ====================
  calendar: router({
    // Create calendar event
    createEvent: protectedProcedure
      .input(z.object({
        title: z.string(),
        description: z.string().optional(),
        startTime: z.date(),
        endTime: z.date(),
        eventType: z.enum(["reminder", "personal", "deadline", "holiday"]),
        isAllDay: z.boolean().default(false),
      }))
      .mutation(async ({ input, ctx }) => {
        const event = await db.createCalendarEvent({
          ...input,
          userId: ctx.user.id,
        });
        return event;
      }),

    // Get user's calendar events
    getMyEvents: protectedProcedure.query(async ({ ctx }) => {
      const events = await db.getCalendarEventsByUserId(ctx.user.id);
      return events;
    }),

    // Get events by date range
    getEventsByDateRange: protectedProcedure
      .input(z.object({
        startDate: z.date(),
        endDate: z.date(),
      }))
      .query(async ({ input, ctx }) => {
        const events = await db.getCalendarEventsByDateRange(ctx.user.id, input.startDate, input.endDate);
        const meetings = await db.getMeetingsByDateRange(input.startDate, input.endDate);
        return { events, meetings };
      }),

    // Update calendar event
    updateEvent: protectedProcedure
      .input(z.object({
        id: z.string(),
        title: z.string().optional(),
        description: z.string().optional(),
        startTime: z.date().optional(),
        endTime: z.date().optional(),
        eventType: z.enum(["reminder", "personal", "deadline", "holiday"]).optional(),
        isAllDay: z.boolean().optional(),
      }))
      .mutation(async ({ input }) => {
        const { id, ...data } = input;
        await db.updateCalendarEvent(id, data);
        return { success: true };
      }),

    // Delete calendar event
    deleteEvent: protectedProcedure
      .input(z.object({ id: z.string() }))
      .mutation(async ({ input }) => {
        await db.deleteCalendarEvent(input.id);
        return { success: true };
      }),
  }),
});
export type AppRouter = typeof appRouter;
