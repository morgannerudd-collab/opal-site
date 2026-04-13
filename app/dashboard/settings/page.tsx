"use client";

import type { Business } from "@/lib/businesses";
import { INTEGRATIONS } from "@/lib/integrations";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import type { CSSProperties } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useActiveBusiness } from "@/components/dashboard/business-context";
import { PageBusinessSelector } from "@/components/dashboard/page-business-selector";
import { useDashboardUser } from "@/components/dashboard/dashboard-user-context";
import { AddBusinessModal } from "@/components/ui/add-business-modal";
import { RoleGate } from "@/components/ui/role-gate";
import { ROLE_PERMISSIONS } from "@/lib/rbac";
import type { RolePermissions, TeamMember, UserRole } from "@/lib/types";
import { useCurrentUserRole } from "@/lib/hooks/use-current-user-role";
import { useBusinessAccess } from "@/lib/hooks/use-business-owner-check";
import { useUserPreferences } from "@/lib/hooks/use-user-preferences";
import { SecuritySettingsTab } from "@/components/settings/security-settings-tab";
import { GoalsSettingsTab } from "@/components/settings/goals-settings-tab";
import { DataSourcesSettingsTab } from "@/components/settings/data-sources-settings-tab";
import { logAction } from "@/lib/audit-log";
import { useIntegrationStatus } from "@/lib/hooks/use-integration-status";
import { PORTFOLIO_BUSINESS_ID } from "@/lib/supabase-app-data";
import {
  fetchBillingProfile,
  fetchTeamMembersForUser,
  updateBusinessProfileFields,
} from "@/lib/supabase-dashboard-pages";
import { isRealBusinessId } from "@/lib/dashboard-guards";
import { supabase } from "@/lib/supabase";
import { DashboardPageSpinner } from "@/components/ui/dashboard-page-states";
import {
  DEFAULT_NOTIFICATION_PREFS,
  isDailyPulseEmailEnabled,
  parseNotificationPrefs,
  type NotificationPrefsCategory,
  type NotificationPrefsV1,
} from "@/lib/notification-prefs";

const TABS = [
  { id: "profile", label: "Business profile" },
  { id: "goals", label: "Goals" },
  { id: "data_sources", label: "Data sources" },
  { id: "branding", label: "Branding" },
  { id: "team", label: "Team & users" },
  { id: "notifications", label: "Notifications" },
  { id: "security", label: "Security" },
  { id: "billing", label: "Plan & billing" },
] as const;

type TabId = (typeof TABS)[number]["id"];

const inputStyle: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: "10px 12px",
  fontSize: "13px",
  background: "var(--bg-secondary)",
  border: "1px solid var(--border-md)",
  borderRadius: "var(--radius-md)",
  color: "var(--text-primary)",
  fontFamily: "inherit",
};

const BRAND_SWATCHES = [
  { id: "green", hex: "#0F6E56" },
  { id: "purple", hex: "#534AB7" },
  { id: "amber", hex: "#BA7517" },
  { id: "coral", hex: "#D85A30" },
  { id: "blue", hex: "#185FA5" },
] as const;

/** Map Opal business theme token → swatch id for the color picker */
const BUSINESS_COLOR_TO_SWATCH: Record<string, string> = {
  "var(--green-mid)": "green",
  "var(--purple-mid)": "purple",
  "var(--amber-mid)": "amber",
  "var(--coral-mid)": "coral",
  "var(--text-secondary)": "blue",
};

/** Settings / onboarding-aligned labels (stored on businesses.type). */
const SETTINGS_BUSINESS_TYPE_LABELS = [
  "Rental/Fleet",
  "Restaurant/Food & Beverage",
  "Retail",
  "Agency/Consulting",
  "Healthcare/Wellness",
  "Real Estate",
  "E-commerce",
  "Franchise/Multi-location",
  "Van Rental",
  "Other",
] as const;

const LEGACY_BUSINESS_TYPE_TO_SETTINGS: Record<string, (typeof SETTINGS_BUSINESS_TYPE_LABELS)[number]> = {
  "Rental / Fleet": "Rental/Fleet",
  "Restaurant / Food & Beverage": "Restaurant/Food & Beverage",
  "Agency / Consulting": "Agency/Consulting",
  "Healthcare / Wellness": "Healthcare/Wellness",
  Franchise: "Franchise/Multi-location",
  Consulting: "Agency/Consulting",
};

function normalizeSettingsBusinessType(raw: string): string {
  const t = raw.trim() || "Other";
  if ((SETTINGS_BUSINESS_TYPE_LABELS as readonly string[]).includes(t)) return t;
  return LEGACY_BUSINESS_TYPE_TO_SETTINGS[t] ?? t;
}

function splitStoredBusinessDescription(raw: string): {
  industryBody: string;
  websiteUrl: string;
  businessEmail: string;
} {
  const lines = (raw ?? "").split("\n");
  const body: string[] = [];
  let websiteUrl = "";
  let businessEmail = "";
  for (const line of lines) {
    const t = line.trim();
    const low = t.toLowerCase();
    if (low.startsWith("website:")) websiteUrl = t.slice(t.indexOf(":") + 1).trim();
    else if (low.startsWith("contact:")) businessEmail = t.slice(t.indexOf(":") + 1).trim();
    else body.push(line);
  }
  return {
    industryBody: body.join("\n").trim(),
    websiteUrl,
    businessEmail,
  };
}

/** Interim onboarding row saves richContextSummaryLines into description until completion overwrites it. */
function isLikelyOnboardingFormDump(body: string): boolean {
  const t = body.trim();
  if (t.length < 40) return false;
  const markers = [
    "Business type:",
    "Operating tenure:",
    "Locations:",
    "Team size:",
    "Top priorities:",
    "Units / locations:",
    "Success focus:",
    "Expense control",
    "Operational challenge:",
  ];
  return markers.filter((m) => t.includes(m)).length >= 3;
}

function polishedDescriptionFromProfilePrefs(
  prefs: unknown,
  businessId: string,
): string {
  const p = prefs as Record<string, unknown> | null | undefined;
  const ic = p?.industryContext;
  if (!ic || typeof ic !== "object") return "";
  const by = (ic as Record<string, unknown>).byBusinessId;
  if (!by || typeof by !== "object") return "";
  const row = (by as Record<string, unknown>)[businessId];
  if (!row || typeof row !== "object") return "";
  const polished = (row as Record<string, unknown>).polishedBusinessDescription;
  return typeof polished === "string" ? polished.trim() : "";
}

type BrandingState = {
  logo: string | null;
  brandColor: string;
  displayName: string;
};

function defaultBrandingForBusiness(b: Business): BrandingState {
  return {
    logo: null,
    brandColor: BUSINESS_COLOR_TO_SWATCH[b.color] ?? "green",
    displayName: b.name,
  };
}

const ROLE_META: Record<
  UserRole,
  { label: string; bg: string; color: string; description: string }
> = {
  owner: {
    label: "Owner",
    bg: "var(--green-light)",
    color: "var(--green-mid)",
    description: "Full access including billing — only one owner allowed",
  },
  admin: {
    label: "Admin",
    bg: "var(--purple-light)",
    color: "var(--purple-mid)",
    description:
      "Full access except billing — can manage users and integrations",
  },
  standard: {
    label: "Standard",
    bg: "var(--bg-secondary)",
    color: "var(--text-secondary)",
    description:
      "Can view assigned businesses — cannot change settings or integrations",
  },
  viewer: {
    label: "Viewer",
    bg: "var(--amber-light)",
    color: "var(--amber-mid)",
    description:
      "Read-only access — cannot export data or use AI features",
  },
};

const CANCEL_REASON_OPTIONS = [
  "Too expensive",
  "Missing features I need",
  "Switching to another tool",
  "No longer need it",
  "Other",
] as const;

const NEXT_BILLING_LABEL = "April 1, 2026";
const ANNUAL_ACCESS_END_LABEL = "March 1, 2027";

const PLAN_CHECKOUT_AMOUNTS = {
  operator: { monthly: 79, annualCharge: 756 },
  studio: { monthly: 249, annualCharge: 2388 },
} as const;

type NotificationTriggerValue =
  | ""
  | "booking_confirmed"
  | "booking_reminder"
  | "revenue_drop"
  | "expense_pct"
  | "maintenance_due"
  | "ai_insight"
  | "team_join"
  | "integration_disconnected"
  | "custom";

type NotificationRuleChannel = "inApp" | "email" | "sms" | "slack" | "teams" | "googleChat";

type NotificationBusinessScope = "all" | string;

type NotificationRule = {
  id: string;
  trigger: NotificationTriggerValue;
  triggerValue: number;
  customDetail: string;
  businessScope: NotificationBusinessScope;
  channels: Record<NotificationRuleChannel, boolean>;
  enabled: boolean;
  saved: boolean;
};

const TRIGGER_OPTIONS: {
  value: Exclude<NotificationTriggerValue, "">;
  label: string;
  hasX: boolean;
}[] = [
  { value: "booking_confirmed", label: "New booking confirmed", hasX: false },
  { value: "booking_reminder", label: "Booking reminder", hasX: false },
  { value: "revenue_drop", label: "Revenue drops by X%", hasX: true },
  { value: "expense_pct", label: "Expense exceeds X% of revenue", hasX: true },
  { value: "maintenance_due", label: "Maintenance due", hasX: false },
  { value: "ai_insight", label: "AI insight ready", hasX: false },
  { value: "team_join", label: "New team member joins", hasX: false },
  { value: "integration_disconnected", label: "Integration disconnected", hasX: false },
  { value: "custom", label: "Custom...", hasX: false },
];

const RULE_CHANNELS: {
  id: NotificationRuleChannel;
  label: string;
  comingSoon: boolean;
}[] = [
  { id: "inApp", label: "In-app", comingSoon: false },
  { id: "email", label: "Email", comingSoon: false },
  { id: "sms", label: "SMS", comingSoon: true },
  { id: "slack", label: "Slack", comingSoon: true },
  { id: "teams", label: "Teams", comingSoon: true },
  { id: "googleChat", label: "Google Chat", comingSoon: true },
];

function emptyChannels(): Record<NotificationRuleChannel, boolean> {
  return {
    inApp: false,
    email: false,
    sms: false,
    slack: false,
    teams: false,
    googleChat: false,
  };
}

function createDefaultNotificationRules(): NotificationRule[] {
  return [
    {
      id: "rule-default-1",
      trigger: "booking_confirmed",
      triggerValue: 0,
      customDetail: "",
      businessScope: "all",
      channels: { ...emptyChannels(), inApp: true, email: true },
      enabled: true,
      saved: true,
    },
    {
      id: "rule-default-2",
      trigger: "revenue_drop",
      triggerValue: 20,
      customDetail: "",
      businessScope: "all",
      channels: { ...emptyChannels(), inApp: true, email: true },
      enabled: true,
      saved: true,
    },
    {
      id: "rule-default-4",
      trigger: "maintenance_due",
      triggerValue: 0,
      customDetail: "",
      businessScope: "1",
      channels: { ...emptyChannels(), inApp: true, email: true },
      enabled: true,
      saved: true,
    },
    {
      id: "rule-default-5",
      trigger: "ai_insight",
      triggerValue: 0,
      customDetail: "",
      businessScope: "all",
      channels: { ...emptyChannels(), inApp: true },
      enabled: true,
      saved: true,
    },
  ];
}

function TrashRuleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 6h18" />
      <path d="M8 6V4h8v2" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  );
}

type ThresholdMetric =
  | ""
  | "rev_drop_pct"
  | "rev_below_usd"
  | "exp_pct_rev"
  | "exp_usd_month"
  | "margin_below_pct"
  | "profit_below_usd"
  | "occ_below_pct"
  | "bookings_below"
  | "custom";

type AlertThresholdPriority = "low" | "medium" | "high";

type AlertThreshold = {
  id: string;
  metric: ThresholdMetric;
  value: number;
  customDetail: string;
  businessScope: NotificationBusinessScope;
  priority: AlertThresholdPriority;
  enabled: boolean;
  saved: boolean;
};

const THRESHOLD_METRIC_OPTIONS: {
  value: Exclude<ThresholdMetric, "">;
  label: string;
}[] = [
  { value: "rev_drop_pct", label: "Revenue drops by X%" },
  { value: "rev_below_usd", label: "Revenue drops below $X" },
  { value: "exp_pct_rev", label: "Expenses exceed X% of revenue" },
  { value: "exp_usd_month", label: "Expenses exceed $X in a month" },
  { value: "margin_below_pct", label: "Profit margin drops below X%" },
  { value: "profit_below_usd", label: "Net profit drops below $X" },
  { value: "occ_below_pct", label: "Occupancy rate drops below X%" },
  { value: "bookings_below", label: "Booking count drops below X per month" },
  { value: "custom", label: "Custom metric..." },
];

function defaultValueForThresholdMetric(m: ThresholdMetric): number {
  switch (m) {
    case "rev_drop_pct":
    case "exp_pct_rev":
      return 20;
    case "margin_below_pct":
      return 40;
    case "occ_below_pct":
      return 50;
    case "rev_below_usd":
    case "exp_usd_month":
    case "profit_below_usd":
      return 1000;
    case "bookings_below":
      return 3;
    default:
      return 0;
  }
}

function thresholdValueAffix(metric: ThresholdMetric): { prefix: string; suffix: string } {
  switch (metric) {
    case "rev_drop_pct":
    case "exp_pct_rev":
    case "margin_below_pct":
    case "occ_below_pct":
      return { prefix: "", suffix: "%" };
    case "rev_below_usd":
    case "exp_usd_month":
    case "profit_below_usd":
      return { prefix: "$", suffix: "" };
    case "bookings_below":
      return { prefix: "", suffix: "per month" };
    default:
      return { prefix: "", suffix: "" };
  }
}

function createDefaultAlertThresholds(): AlertThreshold[] {
  return [
    {
      id: "thresh-default-1",
      metric: "rev_drop_pct",
      value: 20,
      customDetail: "",
      businessScope: "all",
      priority: "high",
      enabled: true,
      saved: true,
    },
    {
      id: "thresh-default-2",
      metric: "exp_pct_rev",
      value: 60,
      customDetail: "",
      businessScope: "all",
      priority: "medium",
      enabled: true,
      saved: true,
    },
    {
      id: "thresh-default-4",
      metric: "margin_below_pct",
      value: 40,
      customDetail: "",
      businessScope: "all",
      priority: "high",
      enabled: true,
      saved: true,
    },
    {
      id: "thresh-default-5",
      metric: "occ_below_pct",
      value: 50,
      customDetail: "",
      businessScope: "1",
      priority: "low",
      enabled: true,
      saved: true,
    },
  ];
}

function ToggleSwitch({
  checked,
  onChange,
  disabled,
  ariaLabel,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  ariaLabel: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => {
        if (!disabled) onChange(!checked);
      }}
      style={{
        width: "32px",
        height: "18px",
        borderRadius: "999px",
        border: "none",
        background: disabled
          ? "var(--border-md)"
          : checked
            ? "var(--green-mid)"
            : "var(--border-md)",
        position: "relative",
        transition: "background 0.2s ease",
        cursor: disabled ? "not-allowed" : "pointer",
        padding: 0,
        flexShrink: 0,
      }}
    >
      <span
        style={{
          position: "absolute",
          top: "2px",
          left: checked ? "16px" : "2px",
          width: "14px",
          height: "14px",
          borderRadius: "50%",
          background: "#ffffff",
          transition: "left 0.2s ease",
          boxShadow: "0 1px 2px rgba(0,0,0,0.12)",
        }}
      />
    </button>
  );
}

function ComingSoonBadge() {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "2px 8px",
        borderRadius: "999px",
        fontSize: "10px",
        fontWeight: 500,
        background: "var(--bg-secondary)",
        color: "var(--text-tertiary)",
      }}
    >
      Coming soon
    </span>
  );
}

function rolePillStyle(role: UserRole): CSSProperties {
  return {
    display: "inline-block",
    padding: "3px 8px",
    borderRadius: "999px",
    fontSize: "12px",
    fontWeight: 500,
    background: ROLE_META[role].bg,
    color: ROLE_META[role].color,
  };
}

export default function SettingsPage() {
  const searchParams = useSearchParams();
  const user = useDashboardUser();
  const { preferences, mergePreferences } = useUserPreferences();
  const { ensureUiState, mergeBusinessUiState: mergeBusinessUiFromContext } = useBusinessAccess();
  const { businesses, loading: businessesLoading, refreshBusinesses } = useActiveBusiness();
  const portfolioBusinessList = useMemo(
    () => businesses.filter((b) => b.id !== PORTFOLIO_BUSINESS_ID && isRealBusinessId(b.id)),
    [businesses],
  );
  const currentRole = useCurrentUserRole();
  const isStandard = currentRole === "standard";
  const canManageUsers = ROLE_PERMISSIONS[currentRole].canManageUsers;
  const canEditNotificationRules = canManageUsers;
  const [activeTab, setActiveTab] = useState<TabId>("profile");
  const [businessName, setBusinessName] = useState("Canopy Van Co.");
  const [isMobile, setIsMobile] = useState(false);
  const [businessType, setBusinessType] = useState<(typeof SETTINGS_BUSINESS_TYPE_LABELS)[number] | string>(
    "Other",
  );
  const [industryDesc, setIndustryDesc] = useState("");
  const [websiteUrl, setWebsiteUrl] = useState("");
  const [businessEmail, setBusinessEmail] = useState("");
  const [brandingBusiness, setBrandingBusiness] = useState<Business | null>(null);
  const [profileSettingsBusiness, setProfileSettingsBusiness] = useState<Business | null>(null);
  const [teamViewFilter, setTeamViewFilter] = useState<"all" | "single">("all");
  const [teamViewBusinessId, setTeamViewBusinessId] = useState<string>("");
  const [bizIdCopied, setBizIdCopied] = useState(false);
  const [profileAdvancedOpen, setProfileAdvancedOpen] = useState(false);
  const [brandingByBusiness, setBrandingByBusiness] = useState<Record<string, BrandingState>>({});
  const logoInputRef = useRef<HTMLInputElement>(null);
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>([]);
  const [billingProfile, setBillingProfile] = useState<Awaited<ReturnType<typeof fetchBillingProfile>>>(null);
  const [openRoleMenuId, setOpenRoleMenuId] = useState<string | null>(null);
  const [openAccessMenuId, setOpenAccessMenuId] = useState<string | null>(null);
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [showRemoveModal, setShowRemoveModal] = useState<string | null>(null);
  const [editMemberId, setEditMemberId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<{
    name: string;
    email: string;
    role: UserRole;
    businessAccess: string[];
    status: "active" | "suspended";
  } | null>(null);
  const [showRolePermissions, setShowRolePermissions] = useState(false);
  const [teamToast, setTeamToast] = useState<string | null>(null);
  const [addBusinessOpen, setAddBusinessOpen] = useState(false);
  const [addBusinessToast, setAddBusinessToast] = useState<string | null>(null);
  const [billingCycle, setBillingCycle] = useState<"monthly" | "annual">("monthly");
  const [billingActionLoading, setBillingActionLoading] = useState<
    null | "upgrade" | "portal" | "payment"
  >(null);
  const [cancelModalOpen, setCancelModalOpen] = useState(false);
  const [cancelPhase, setCancelPhase] = useState<"form" | "success">("form");
  const [cancelReason, setCancelReason] = useState("");
  const [cancelFeedback, setCancelFeedback] = useState("");
  const [cancelSubmitting, setCancelSubmitting] = useState(false);
  const [cancelMessage, setCancelMessage] = useState<string | null>(null);
  const [subscriptionCancelled, setSubscriptionCancelled] = useState<{
    accessUntilLabel: string;
  } | null>(null);
  const [billingAuthOpen, setBillingAuthOpen] = useState(false);
  const [billingAuthPlan, setBillingAuthPlan] = useState<"operator" | "studio">("studio");
  const [billingAuthAgreed, setBillingAuthAgreed] = useState(false);

  const [draftBusinessAccessByMember, setDraftBusinessAccessByMember] = useState<
    Record<string, string[]>
  >({});
  const [roleWarningByMember, setRoleWarningByMember] = useState<Record<string, string>>({});
  const [inviteForm, setInviteForm] = useState<{
    name: string;
    email: string;
    role: UserRole;
    businessAccess: string[];
  }>({
    name: "",
    email: "",
    role: "standard",
    businessAccess: [],
  });

  const [notifSlackEnabled, setNotifSlackEnabled] = useState(false);
  const [notifGoogleWorkspaceEnabled, setNotifGoogleWorkspaceEnabled] = useState(false);
  const [dismissedDeliveryBanner, setDismissedDeliveryBanner] = useState(false);

  const [notificationRules, setNotificationRules] = useState<NotificationRule[]>(
    createDefaultNotificationRules,
  );

  const [alertThresholds, setAlertThresholds] = useState<AlertThreshold[]>(
    createDefaultAlertThresholds,
  );

  const [notifEmailEnabled, setNotifEmailEnabled] = useState(true);
  const [notifEmailAddress, setNotifEmailAddress] = useState("");
  const [smartNotifPrefs, setSmartNotifPrefs] = useState<NotificationPrefsV1>(() => ({
    ...DEFAULT_NOTIFICATION_PREFS,
  }));
  const [dailyPulseEmailEnabled, setDailyPulseEmailEnabled] = useState(true);
  useEffect(() => {
    if (user.email) setNotifEmailAddress(user.email);
  }, [user.email]);
  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < 768);
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    const tab = searchParams.get("tab");
    if (tab && TABS.some((item) => item.id === tab)) {
      setActiveTab(tab as TabId);
    }
  }, [searchParams]);

  useEffect(() => {
    const sub = preferences.subscriptionCancelled;
    if (sub?.cancelled && sub.accessUntilLabel) {
      setSubscriptionCancelled({ accessUntilLabel: sub.accessUntilLabel });
    }
    setSmartNotifPrefs(parseNotificationPrefs(preferences.notificationPrefs));
    setDailyPulseEmailEnabled(isDailyPulseEmailEnabled(preferences));
  }, [preferences]);
  useEffect(() => {
    if (!teamToast) return;
    const t = window.setTimeout(() => setTeamToast(null), 2500);
    return () => window.clearTimeout(t);
  }, [teamToast]);
  useEffect(() => {
    if (!addBusinessToast) return;
    const t = window.setTimeout(() => setAddBusinessToast(null), 2600);
    return () => window.clearTimeout(t);
  }, [addBusinessToast]);

  useEffect(() => {
    void fetchTeamMembersForUser(user.id).then(setTeamMembers);
  }, [user.id]);

  useEffect(() => {
    void fetchBillingProfile(user.id).then(setBillingProfile);
  }, [user.id]);

  useEffect(() => {
    if (portfolioBusinessList.length === 0) return;
    setBrandingByBusiness((prev) => {
      const n = { ...prev };
      for (const b of portfolioBusinessList) {
        if (!n[b.id]) n[b.id] = defaultBrandingForBusiness(b);
      }
      return n;
    });
    setBrandingBusiness((prev) => {
      if (prev && portfolioBusinessList.some((x) => x.id === prev.id)) return prev;
      return portfolioBusinessList[0]!;
    });
    setProfileSettingsBusiness((prev) => {
      if (prev && portfolioBusinessList.some((x) => x.id === prev.id)) return prev;
      return portfolioBusinessList[0]!;
    });
    setTeamViewBusinessId((prev) => {
      if (prev && portfolioBusinessList.some((b) => b.id === prev)) return prev;
      return portfolioBusinessList[0]!.id;
    });
  }, [portfolioBusinessList]);

  useEffect(() => {
    const bid = profileSettingsBusiness?.id;
    if (!bid || !isRealBusinessId(bid)) return;
    let cancelled = false;
    void (async () => {
      const { data } = await supabase
        .from("businesses")
        .select("name, type, description")
        .eq("id", bid)
        .maybeSingle();
      if (cancelled || !data) return;
      setBusinessName(data.name);
      setBusinessType(normalizeSettingsBusinessType(data.type ?? "Other"));
      const raw = data.description ?? "";
      const { industryBody, websiteUrl: w, businessEmail: c } = splitStoredBusinessDescription(raw);
      const polished = polishedDescriptionFromProfilePrefs(preferences, bid);
      let industry = "";
      if (polished) {
        industry = polished;
      } else if (!isLikelyOnboardingFormDump(industryBody)) {
        industry = industryBody;
      }
      setIndustryDesc(industry);
      setWebsiteUrl(w);
      setBusinessEmail(c);
    })();
    return () => {
      cancelled = true;
    };
  }, [profileSettingsBusiness?.id, user.id, preferences]);

  useEffect(() => {
    const bid = brandingBusiness?.id;
    if (!bid || !isRealBusinessId(bid)) return;
    let cancelled = false;
    void ensureUiState(bid).then((ui) => {
      if (cancelled) return;
      const raw = ui.branding;
      if (raw && typeof raw === "object") {
        const logo =
          raw.logo_url === null
            ? null
            : typeof raw.logo_url === "string"
              ? raw.logo_url
              : null;
        const hex =
          typeof raw.accent_hex === "string" && raw.accent_hex.trim()
            ? raw.accent_hex.trim()
            : "#0F6E56";
        const display =
          typeof raw.display_name === "string" && raw.display_name.trim()
            ? raw.display_name.trim()
            : brandingBusiness?.name ?? "";
        const swatchId =
          typeof raw.brand_color_id === "string" &&
          BRAND_SWATCHES.some((s) => s.id === raw.brand_color_id)
            ? raw.brand_color_id
            : (BRAND_SWATCHES.find((s) => s.hex.toLowerCase() === hex.toLowerCase())?.id ?? "green");
        setBrandingByBusiness((prev) => ({
          ...prev,
          [bid]: {
            logo,
            brandColor: swatchId,
            displayName: display,
          },
        }));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [brandingBusiness?.id, ensureUiState]);

  useEffect(() => {
    if (portfolioBusinessList.length === 0) return;
    setInviteForm((p) => ({
      ...p,
      businessAccess:
        p.businessAccess.length > 0
          ? p.businessAccess.filter((id) => portfolioBusinessList.some((b) => b.id === id))
          : [portfolioBusinessList[0]!.id],
    }));
  }, [portfolioBusinessList]);

  function patchNotificationRule(id: string, patch: Partial<NotificationRule>) {
    setNotificationRules((prev) =>
      prev.map((r) => (r.id === id ? { ...r, ...patch } : r)),
    );
  }

  function addNotificationRule() {
    setNotificationRules((prev) => [
      ...prev,
      {
        id: `rule-new-${Date.now()}`,
        trigger: "",
        triggerValue: 20,
        customDetail: "",
        businessScope: "all",
        channels: emptyChannels(),
        enabled: true,
        saved: false,
      },
    ]);
  }

  function deleteNotificationRule(id: string) {
    setNotificationRules((prev) => prev.filter((r) => r.id !== id));
  }

  function saveDraftRule(id: string) {
    patchNotificationRule(id, { saved: true });
  }

  function patchAlertThreshold(id: string, patch: Partial<AlertThreshold>) {
    setAlertThresholds((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }

  function addAlertThreshold() {
    setAlertThresholds((prev) => [
      ...prev,
      {
        id: `thresh-new-${Date.now()}`,
        metric: "",
        value: 0,
        customDetail: "",
        businessScope: "all",
        priority: "medium",
        enabled: true,
        saved: false,
      },
    ]);
  }

  function deleteAlertThreshold(id: string) {
    setAlertThresholds((prev) => prev.filter((t) => t.id !== id));
  }

  function saveDraftThreshold(id: string) {
    patchAlertThreshold(id, { saved: true });
  }

  const selectRuleStyle: CSSProperties = {
    width: "100%",
    boxSizing: "border-box",
    padding: "10px 12px",
    fontSize: "13px",
    background: "var(--bg-secondary)",
    border: "1px solid var(--border-md)",
    borderRadius: "var(--radius-md)",
    color: "var(--text-primary)",
    fontFamily: "inherit",
    cursor: "pointer",
  };

  const ruleSectionLabel: CSSProperties = {
    fontSize: "10px",
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    color: "var(--text-tertiary)",
    fontWeight: 500,
    marginBottom: "8px",
  };

  const integrationBusinessId =
    brandingBusiness &&
    brandingBusiness.id !== PORTFOLIO_BUSINESS_ID &&
    isRealBusinessId(brandingBusiness.id)
      ? brandingBusiness.id
      : undefined;
  const { connected: slackConnected } = useIntegrationStatus("slack", integrationBusinessId);
  const { connected: googleWorkspaceConnected } = useIntegrationStatus(
    "google-workspace",
    integrationBusinessId,
  );
  const showDeliveryBanner =
    !dismissedDeliveryBanner && (!slackConnected || !googleWorkspaceConnected);

  const activeBranding: BrandingState | null = brandingBusiness
    ? (brandingByBusiness[brandingBusiness.id] ?? defaultBrandingForBusiness(brandingBusiness))
    : null;

  function updateBrandingFields(updates: Partial<BrandingState>) {
    if (!brandingBusiness) return;
    setBrandingByBusiness((prev) => {
      const id = brandingBusiness.id;
      const current = prev[id] ?? defaultBrandingForBusiness(brandingBusiness);
      return { ...prev, [id]: { ...current, ...updates } };
    });
  }

  async function handleSaveBranding() {
    if (!brandingBusiness || !isRealBusinessId(brandingBusiness.id)) return;
    const id = brandingBusiness.id;
    const current = brandingByBusiness[id] ?? defaultBrandingForBusiness(brandingBusiness);
    const hex = BRAND_SWATCHES.find((s) => s.id === current.brandColor)?.hex ?? "#0F6E56";
    await mergeBusinessUiFromContext(id, (prev) => ({
      ...prev,
      branding: {
        logo_url: current.logo,
        accent_hex: hex,
        display_name: current.displayName.trim() || brandingBusiness.name,
        brand_color_id: current.brandColor,
      },
    }));
    setTeamToast("Branding saved");
  }

  async function saveBusinessProfileForm() {
    const bid = profileSettingsBusiness?.id;
    if (!bid || !isRealBusinessId(bid)) {
      setTeamToast("No business to save.");
      return;
    }
    const desc = [
      industryDesc.trim(),
      websiteUrl.trim() ? `Website: ${websiteUrl.trim()}` : "",
      businessEmail.trim() ? `Contact: ${businessEmail.trim()}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    await updateBusinessProfileFields(bid, {
      name: businessName.trim(),
      type: businessType,
      ...(desc ? { description: desc } : {}),
    });
    await refreshBusinesses();
    setTeamToast("Business profile saved");
  }

  async function performStripeCheckout(planId: "operator" | "studio") {
    setBillingActionLoading("upgrade");
    try {
      const res = await fetch("/api/stripe/create-checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          planId,
          billingCycle,
          customerEmail: user.email,
        }),
      });
      const data = (await res.json()) as { url?: string; error?: string };
      if (!res.ok || !data.url) throw new Error(data.error || "Unable to start checkout");
      window.location.href = data.url;
    } catch (error) {
      console.error(error);
      setTeamToast("Could not start Stripe checkout.");
      setTimeout(() => setTeamToast(null), 3000);
    } finally {
      setBillingActionLoading(null);
    }
  }

  function openBillingAuth(planId: "operator" | "studio") {
    setBillingAuthPlan(planId);
    setBillingAuthAgreed(false);
    setBillingAuthOpen(true);
  }

  function confirmBillingAuth() {
    if (!billingAuthAgreed) return;
    logAction("Payment authorized", "billing", billingAuthPlan, {
      userId: user.id,
    });
    setBillingAuthOpen(false);
    void performStripeCheckout(billingAuthPlan);
  }

  function openCancelModal() {
    setCancelPhase("form");
    setCancelReason("");
    setCancelFeedback("");
    setCancelMessage(null);
    setCancelModalOpen(true);
  }

  async function confirmSubscriptionCancel() {
    if (!cancelReason) return;
    setCancelSubmitting(true);
    setCancelMessage(null);
    try {
      const response = await fetch("/api/stripe/cancel", { method: "POST" });
      const data = (await response.json()) as { error?: string; cancel_date?: string; success?: boolean };

      if (!response.ok) {
        throw new Error(data.error || "Failed to cancel subscription");
      }

      const accessUntilLabel =
        data.cancel_date ??
        (billingCycle === "monthly" ? NEXT_BILLING_LABEL : ANNUAL_ACCESS_END_LABEL);

      void mergePreferences((p) => ({
        ...p,
        subscriptionCancelled: {
          cancelled: true,
          reason: cancelReason,
          feedback: cancelFeedback.trim(),
          accessUntilLabel,
          billingCycle,
          at: new Date().toISOString(),
        },
      }));
      setSubscriptionCancelled({ accessUntilLabel });
      logAction("Subscription cancelled", "billing", cancelReason, {
        userId: user.id,
      });

      setTeamToast(
        `Your subscription has been cancelled. You'll have full access until ${accessUntilLabel}.`,
      );
      setTimeout(() => setTeamToast(null), 6000);
      setCancelModalOpen(false);
    } catch (err) {
      console.error("Cancel error:", err);
      setCancelMessage(
        err instanceof Error ? err.message : "Something went wrong. Please contact info@myopal.io",
      );
    } finally {
      setCancelSubmitting(false);
    }
  }

  async function openStripePortal(action: "portal" | "payment") {
    setBillingActionLoading(action);
    try {
      const res = await fetch("/api/stripe/portal", { method: "POST" });
      const data = (await res.json()) as { url?: string; error?: string };
      if (!res.ok || !data.url) throw new Error(data.error || "Unable to open portal");
      window.location.href = data.url;
    } catch (error) {
      console.error(error);
      setTeamToast("Could not open Stripe portal.");
      setTimeout(() => setTeamToast(null), 3000);
    } finally {
      setBillingActionLoading(null);
    }
  }

  const labelStyle: CSSProperties = {
    display: "block",
    fontSize: "12px",
    fontWeight: 500,
    color: "var(--text-secondary)",
    marginBottom: "6px",
  };

  const fieldGap: CSSProperties = { marginBottom: "16px" };

  const displayedTeamMembers = useMemo(() => {
    if (teamViewFilter === "all") return teamMembers;
    const bid = teamViewBusinessId;
    if (!bid) return teamMembers;
    return teamMembers.filter(
      (m) => m.role === "owner" || m.role === "admin" || m.businessAccess.includes(bid),
    );
  }, [teamMembers, teamViewFilter, teamViewBusinessId]);

  const primaryBtn: CSSProperties = {
    padding: "10px 18px",
    borderRadius: "var(--radius-md)",
    border: "none",
    background: "var(--green-mid)",
    color: "var(--green-light)",
    fontSize: "13px",
    fontWeight: 600,
    fontFamily: "inherit",
    cursor: "pointer",
  };

  function updateMemberRole(id: string, role: UserRole) {
    setTeamMembers((prev) =>
      prev.map((m) => {
        if (m.id !== id) return m;
        const nextAccess =
          role === "owner" || role === "admin" ? portfolioBusinessList.map((b) => b.id) : m.businessAccess;
        return { ...m, role, businessAccess: nextAccess };
      }),
    );
    setOpenRoleMenuId(null);
  }

  function toggleMemberBusinessAccess(id: string, businessId: string) {
    setDraftBusinessAccessByMember((prev) => {
      const current = prev[id] ?? teamMembers.find((m) => m.id === id)?.businessAccess ?? [];
      const has = current.includes(businessId);
      const nextAccess = has ? current.filter((b) => b !== businessId) : [...current, businessId];
      return { ...prev, [id]: nextAccess.length ? nextAccess : [businessId] };
    });
  }

  function resendInvite(email: string) {
    setTeamToast(`Invitation resent to ${email}`);
  }

  function sendInvite() {
    if (!inviteForm.name.trim() || !inviteForm.email.trim()) return;
    const nextMember: TeamMember = {
      id: `tm_${Date.now()}`,
      name: inviteForm.name.trim(),
      email: inviteForm.email.trim(),
      role: inviteForm.role,
      status: "invited",
      businessAccess:
        inviteForm.role === "owner" || inviteForm.role === "admin"
          ? portfolioBusinessList.map((b) => b.id)
          : inviteForm.businessAccess,
    };
    setTeamMembers((prev) => [...prev, nextMember]);
    setShowInviteModal(false);
    setTeamToast(`Invitation sent to ${nextMember.email}`);
    setInviteForm({
      name: "",
      email: "",
      role: "standard",
      businessAccess: portfolioBusinessList[0] ? [portfolioBusinessList[0].id] : [],
    });
    logAction("Team member invited", "team", nextMember.email, {
      userId: user.email ?? undefined,
    });
  }

  function roleRank(role: UserRole): number {
    if (role === "owner") return 4;
    if (role === "admin") return 3;
    if (role === "standard") return 2;
    return 1;
  }

  function openEditMember(member: TeamMember) {
    setEditMemberId(member.id);
    setEditForm({
      name: member.name,
      email: member.email,
      role: member.role,
      businessAccess: member.businessAccess,
      status: member.status === "suspended" ? "suspended" : "active",
    });
  }

  async function copyProfileBusinessId() {
    const id = profileSettingsBusiness?.id;
    if (!id || !isRealBusinessId(id)) return;
    try {
      await navigator.clipboard.writeText(id);
      setBizIdCopied(true);
      window.setTimeout(() => setBizIdCopied(false), 2000);
    } catch {
      setTeamToast("Could not copy to clipboard");
    }
  }

  function saveEditedMember() {
    if (!editMemberId || !editForm) return;
    setTeamMembers((prev) =>
      prev.map((m) => {
        if (m.id !== editMemberId) return m;
        const nextAccess =
          editForm.role === "owner" || editForm.role === "admin"
            ? portfolioBusinessList.map((b) => b.id)
            : editForm.businessAccess;
        return {
          ...m,
          name: editForm.name.trim() || m.name,
          email: editForm.email.trim() || m.email,
          role: editForm.role,
          status: editForm.status,
          businessAccess: nextAccess.length ? nextAccess : m.businessAccess,
        };
      }),
    );
    setTeamToast(`✓ ${editForm.name}'s profile updated`);
    setEditMemberId(null);
    setEditForm(null);
  }

  if (businessesLoading) {
    return <DashboardPageSpinner label="Loading settings…" />;
  }

  return (
    <div>
      <header style={{ marginBottom: 0 }}>
        <h1
          style={{
            margin: 0,
            fontSize: "24px",
            fontWeight: 500,
            fontFamily: "'Cormorant Garamond', serif",
            color: "var(--text-primary)",
            lineHeight: 1.2,
          }}
        >
          Account Settings
        </h1>
        <p
          style={{
            margin: "8px 0 32px",
            fontSize: "14px",
            color: "var(--text-secondary)",
            lineHeight: 1.5,
          }}
        >
          Manage your account, business profile, branding, and team.
        </p>
      </header>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: isMobile ? "1fr" : "200px minmax(0, 1fr)",
          gap: "32px",
          alignItems: "start",
        }}
      >
        <nav
          style={{
            display: "flex",
            flexDirection: isMobile ? "row" : "column",
            gap: "4px",
            overflowX: isMobile ? "auto" : "visible",
            paddingBottom: isMobile ? "4px" : 0,
          }}
          aria-label="Account settings sections"
        >
          {TABS.filter((tab) => {
            if (isStandard)
              return (
                tab.id === "profile" ||
                tab.id === "notifications" ||
                tab.id === "security" ||
                tab.id === "billing"
              );
            if (tab.id === "goals") return ROLE_PERMISSIONS[currentRole].canEditBusinesses;
            if (tab.id === "data_sources") return ROLE_PERMISSIONS[currentRole].canEditBusinesses;
            if (tab.id === "branding") return ROLE_PERMISSIONS[currentRole].canManageBranding;
            return true;
          }).map((tab) => {
            const active = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                style={{
                  textAlign: "left",
                  padding: "10px 14px",
                  whiteSpace: "nowrap",
                  borderRadius: "var(--radius-md)",
                  border: "none",
                  background: active ? "var(--green-light)" : "transparent",
                  color: active ? "var(--green-mid)" : "var(--text-primary)",
                  fontSize: "13px",
                  fontWeight: active ? 500 : 400,
                  fontFamily: "inherit",
                  cursor: "pointer",
                }}
                onMouseEnter={(e) => {
                  if (!active) {
                    e.currentTarget.style.background = "var(--bg-secondary)";
                  }
                }}
                onMouseLeave={(e) => {
                  if (!active) {
                    e.currentTarget.style.background = "transparent";
                  }
                }}
              >
                {tab.label}
              </button>
            );
          })}
        </nav>

        <div style={{ minWidth: 0 }}>
          {activeTab === "profile" ? (
            <>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: "16px",
                  marginBottom: "24px",
                  maxWidth: isMobile ? "100%" : "520px",
                }}
              >
                <h2
                  style={{
                    margin: 0,
                    fontSize: "18px",
                    fontWeight: 500,
                    fontFamily: "'Cormorant Garamond', serif",
                    color: "var(--text-primary)",
                    lineHeight: 1.2,
                  }}
                >
                  Business profile
                </h2>
                <RoleGate permission="canEditBusinesses">
                  <button
                    type="button"
                    onClick={() => setAddBusinessOpen(true)}
                    style={{
                      flexShrink: 0,
                      border: "1px solid var(--border-md)",
                      background: "transparent",
                      color: "var(--text-primary)",
                      borderRadius: "var(--radius-md)",
                      padding: "6px 12px",
                      fontSize: "13px",
                      cursor: "pointer",
                      fontFamily: "inherit",
                      fontWeight: 500,
                    }}
                  >
                    + Add business
                  </button>
                </RoleGate>
              </div>
              {portfolioBusinessList.length === 0 ? (
                <p style={{ margin: "0 0 20px", fontSize: "13px", color: "var(--text-tertiary)", maxWidth: "520px" }}>
                  You don&apos;t have any businesses yet. Use &quot;Add business&quot; above to create one, then edit
                  its profile here.
                </p>
              ) : null}
              {portfolioBusinessList.length > 0 && profileSettingsBusiness ? (
                <div style={{ marginBottom: "20px", maxWidth: isMobile ? "100%" : "520px" }}>
                  <div style={{ fontSize: "12px", color: "var(--text-tertiary)", marginBottom: "8px" }}>
                    Business
                  </div>
                  <PageBusinessSelector
                    selectedBusiness={profileSettingsBusiness}
                    onSelect={setProfileSettingsBusiness}
                  />
                </div>
              ) : null}
            {portfolioBusinessList.length > 0 ? (
            <>
            <form
              onSubmit={(e) => e.preventDefault()}
              style={{ maxWidth: isMobile ? "100%" : "520px" }}
            >
              <div style={fieldGap}>
                <label htmlFor="biz-name" style={labelStyle}>
                  Business name
                </label>
                <input
                  id="biz-name"
                  type="text"
                  value={businessName}
                  onChange={(e) => setBusinessName(e.target.value)}
                  disabled={isStandard}
                  style={inputStyle}
                />
              </div>
              <div style={fieldGap}>
                <label htmlFor="biz-type" style={labelStyle}>
                  Business type
                </label>
                <select
                  id="biz-type"
                  value={businessType}
                  onChange={(e) => setBusinessType(e.target.value)}
                  disabled={isStandard}
                  style={{ ...inputStyle, cursor: "pointer" }}
                >
                  {!(SETTINGS_BUSINESS_TYPE_LABELS as readonly string[]).includes(businessType) ? (
                    <option value={businessType}>{businessType}</option>
                  ) : null}
                  {SETTINGS_BUSINESS_TYPE_LABELS.map((label) => (
                    <option key={label} value={label}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
              <div style={fieldGap}>
                <label htmlFor="industry" style={labelStyle}>
                  Industry description
                </label>
                <textarea
                  id="industry"
                  rows={3}
                  value={industryDesc}
                  onChange={(e) => setIndustryDesc(e.target.value)}
                  disabled={isStandard}
                  placeholder="Add a description of your business."
                  style={{ ...inputStyle, resize: "vertical", minHeight: "72px" }}
                />
              </div>
              <div style={fieldGap}>
                <label htmlFor="website" style={labelStyle}>
                  Website URL
                </label>
                <input
                  id="website"
                  type="url"
                  placeholder="https://"
                  value={websiteUrl}
                  onChange={(e) => setWebsiteUrl(e.target.value)}
                  disabled={isStandard}
                  style={inputStyle}
                />
              </div>
              <div style={fieldGap}>
                <label htmlFor="biz-email" style={labelStyle}>
                  Business email
                </label>
                <input
                  id="biz-email"
                  type="email"
                  value={businessEmail}
                  onChange={(e) => setBusinessEmail(e.target.value)}
                  disabled={isStandard}
                  style={inputStyle}
                />
              </div>
              {isStandard ? (
                <p style={{ margin: "12px 0 0", fontSize: "12px", color: "var(--text-tertiary)" }}>
                  View only for your role.
                </p>
              ) : (
                <button type="button" style={{ ...primaryBtn, marginTop: "16px" }} onClick={() => void saveBusinessProfileForm()}>
                  Save changes
                </button>
              )}
            </form>
            {profileSettingsBusiness ? (
              <div style={{ maxWidth: isMobile ? "100%" : "520px", marginTop: "24px" }}>
                <button
                  type="button"
                  id="profile-advanced-toggle"
                  aria-expanded={profileAdvancedOpen}
                  aria-controls="profile-advanced-panel"
                  onClick={() => setProfileAdvancedOpen((o) => !o)}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "8px",
                    border: "none",
                    background: "transparent",
                    padding: "6px 0",
                    fontSize: "13px",
                    fontWeight: 500,
                    color: "var(--text-secondary)",
                    cursor: "pointer",
                    fontFamily: "inherit",
                  }}
                >
                  <span
                    aria-hidden
                    style={{
                      display: "inline-block",
                      fontSize: "9px",
                      color: "var(--text-tertiary)",
                      transform: profileAdvancedOpen ? "rotate(90deg)" : "rotate(0deg)",
                      transition: "transform 0.15s ease",
                    }}
                  >
                    ▶
                  </span>
                  Advanced
                </button>
                {profileAdvancedOpen ? (
                  <div
                    id="profile-advanced-panel"
                    role="region"
                    aria-labelledby="profile-advanced-toggle"
                    style={{
                      marginTop: "12px",
                      paddingTop: "16px",
                      borderTop: "1px solid var(--border-md)",
                    }}
                  >
                    <label htmlFor="biz-id-adv" style={labelStyle}>
                      Business ID (for API integrations)
                    </label>
                    <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
                      <input
                        id="biz-id-adv"
                        type="text"
                        readOnly
                        aria-readonly="true"
                        value={
                          profileSettingsBusiness.id && isRealBusinessId(profileSettingsBusiness.id)
                            ? profileSettingsBusiness.id
                            : "—"
                        }
                        style={{
                          ...inputStyle,
                          flex: "1 1 240px",
                          fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                          fontSize: "12px",
                        }}
                      />
                      <button
                        type="button"
                        disabled={!isRealBusinessId(profileSettingsBusiness.id)}
                        onClick={() => void copyProfileBusinessId()}
                        style={{
                          ...primaryBtn,
                          flexShrink: 0,
                          padding: "8px 14px",
                          opacity: isRealBusinessId(profileSettingsBusiness.id) ? 1 : 0.45,
                        }}
                      >
                        {bizIdCopied ? "Copied!" : "Copy"}
                      </button>
                    </div>
                    <p style={{ margin: "8px 0 0", fontSize: "11px", color: "var(--text-tertiary)", lineHeight: 1.45 }}>
                      You&apos;ll need this if connecting via API or Make.com
                    </p>
                  </div>
                ) : null}
              </div>
            ) : null}
            </>
            ) : null}
            </>
          ) : null}

          {activeTab === "goals" ? (
            <RoleGate permission="canEditBusinesses">
              <GoalsSettingsTab />
            </RoleGate>
          ) : null}

          {activeTab === "data_sources" ? (
            <RoleGate permission="canEditBusinesses">
              <DataSourcesSettingsTab />
            </RoleGate>
          ) : null}

          {activeTab === "branding" ? (
            <RoleGate permission="canManageBranding" fallback={<p style={{ color: "var(--text-tertiary)", fontSize: "13px" }}>You don&apos;t have permission to manage branding.</p>}>
            <div style={{ maxWidth: "520px" }}>
              <p
                style={{
                  margin: "0 0 12px",
                  fontSize: "12px",
                  fontWeight: 500,
                  color: "var(--text-secondary)",
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                }}
              >
                Configure branding per business
              </p>
              {portfolioBusinessList.length === 0 ? (
                <p style={{ margin: "0 0 16px", fontSize: "13px", color: "var(--text-tertiary)" }}>
                  Add a business first to configure branding.
                </p>
              ) : (
                <div style={{ marginBottom: "20px" }}>
                  <div
                    style={{
                      fontSize: "12px",
                      color: "var(--text-tertiary)",
                      marginBottom: "8px",
                    }}
                  >
                    Business
                  </div>
                  <PageBusinessSelector
                    selectedBusiness={brandingBusiness ?? portfolioBusinessList[0]!}
                    onSelect={setBrandingBusiness}
                  />
                </div>
              )}

              {brandingBusiness && activeBranding ? (
              <>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "10px",
                  marginBottom: "16px",
                }}
              >
                <span
                  aria-hidden
                  style={{
                    width: "10px",
                    height: "10px",
                    borderRadius: "50%",
                    background: brandingBusiness.color,
                    flexShrink: 0,
                  }}
                />
                <h2
                  style={{
                    margin: 0,
                    fontSize: "16px",
                    fontWeight: 500,
                    color: "var(--text-primary)",
                    lineHeight: 1.3,
                  }}
                >
                  Branding for {brandingBusiness.name}
                </h2>
              </div>

              <div
                style={{
                  background: "var(--purple-light)",
                  color: "var(--purple-mid)",
                  borderRadius: "var(--radius-md)",
                  padding: "12px 16px",
                  fontSize: "13px",
                  lineHeight: 1.5,
                  marginBottom: "24px",
                }}
              >
                Branding is saved per business and stored with this workspace. Logo and colors
                will apply across the dashboard for this business as features roll out.
              </div>

              <input
                ref={logoInputRef}
                type="file"
                accept="image/*"
                style={{ display: "none" }}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  const reader = new FileReader();
                  reader.onload = () => {
                    const dataUrl =
                      typeof reader.result === "string" ? reader.result : null;
                    updateBrandingFields({ logo: dataUrl });
                  };
                  reader.readAsDataURL(file);
                  e.target.value = "";
                }}
              />

              <div style={{ marginBottom: "24px" }}>
                <div
                  style={{
                    width: "80px",
                    height: "80px",
                    borderRadius: "var(--radius-lg)",
                    border: "2px dashed var(--border-md)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    cursor: "pointer",
                    boxSizing: "border-box",
                    overflow: "hidden",
                    background: activeBranding.logo
                      ? `url(${activeBranding.logo}) center / cover no-repeat`
                      : undefined,
                  }}
                  role="button"
                  tabIndex={0}
                  onClick={() => logoInputRef.current?.click()}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      logoInputRef.current?.click();
                    }
                  }}
                >
                  {!activeBranding.logo ? (
                    <span
                      style={{ fontSize: "12px", color: "var(--text-tertiary)" }}
                    >
                      Upload logo
                    </span>
                  ) : null}
                </div>
              </div>

              <div style={{ marginBottom: "24px" }}>
                <span style={{ ...labelStyle, marginBottom: "10px" }}>
                  Brand color
                </span>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "10px",
                    flexWrap: "wrap",
                  }}
                >
                  {BRAND_SWATCHES.map((sw) => {
                    const selected = activeBranding.brandColor === sw.id;
                    return (
                      <button
                        key={sw.id}
                        type="button"
                        aria-label={`Color ${sw.hex}`}
                        onClick={() =>
                          updateBrandingFields({ brandColor: sw.id })
                        }
                        style={{
                          width: "28px",
                          height: "28px",
                          borderRadius: "50%",
                          border: "none",
                          padding: 0,
                          background: sw.hex,
                          cursor: "pointer",
                          boxSizing: "border-box",
                          outline: selected ? `2px solid ${sw.hex}` : "none",
                          outlineOffset: selected ? "2px" : 0,
                        }}
                      />
                    );
                  })}
                  <button
                    type="button"
                    aria-label="Custom color"
                    onClick={() =>
                      updateBrandingFields({ brandColor: "custom" })
                    }
                    style={{
                      width: "28px",
                      height: "28px",
                      borderRadius: "50%",
                      border: "2px dashed var(--border-md)",
                      padding: 0,
                      background: "var(--bg-secondary)",
                      color: "var(--text-tertiary)",
                      fontSize: "11px",
                      fontWeight: 600,
                      cursor: "pointer",
                      boxSizing: "border-box",
                      outline:
                        activeBranding.brandColor === "custom"
                          ? "2px solid var(--text-tertiary)"
                          : "none",
                      outlineOffset:
                        activeBranding.brandColor === "custom" ? "2px" : 0,
                    }}
                  >
                    +
                  </button>
                </div>
              </div>

              <div style={{ ...fieldGap, marginBottom: "24px" }}>
                <label htmlFor="brand-display" style={labelStyle}>
                  How your business name appears to clients
                </label>
                <input
                  id="brand-display"
                  type="text"
                  value={activeBranding.displayName}
                  onChange={(e) =>
                    updateBrandingFields({ displayName: e.target.value })
                  }
                  style={inputStyle}
                />
              </div>

              <button type="button" style={primaryBtn} onClick={() => void handleSaveBranding()}>
                Save branding
              </button>
              </>
              ) : null}
            </div>
            </RoleGate>
          ) : null}

          {activeTab === "team" ? (
            <div style={{ maxWidth: "720px" }}>
              <div style={{ marginBottom: "16px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <h2 style={{ margin: 0, fontSize: "14px", fontWeight: 500, color: "var(--text-primary)" }}>
                  Team members
                </h2>
                <RoleGate permission="canManageUsers">
                  <button
                    type="button"
                    onClick={() => setShowInviteModal(true)}
                    style={{
                      border: "none",
                      background: "var(--green-mid)",
                      color: "#fff",
                      fontSize: "13px",
                      fontWeight: 500,
                      fontFamily: "inherit",
                      padding: "8px 14px",
                      borderRadius: "var(--radius-md)",
                      cursor: "pointer",
                    }}
                  >
                    Invite member
                  </button>
                </RoleGate>
              </div>
              {!canManageUsers ? (
                <div
                  style={{
                    background: "var(--bg-secondary)",
                    borderRadius: "var(--radius-md)",
                    padding: "10px 14px",
                    marginBottom: "16px",
                    fontSize: "12px",
                    color: "var(--text-secondary)",
                    lineHeight: 1.5,
                  }}
                >
                  You have view-only access to team settings. Contact your admin to make
                  changes.
                </div>
              ) : null}

              {canManageUsers && portfolioBusinessList.length > 0 ? (
                <div
                  style={{
                    marginBottom: "16px",
                    display: "flex",
                    flexDirection: "column",
                    gap: "10px",
                  }}
                >
                  <div style={{ fontSize: "12px", color: "var(--text-tertiary)" }}>
                    Team list scope
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", alignItems: "center" }}>
                    <button
                      type="button"
                      onClick={() => setTeamViewFilter("all")}
                      style={{
                        border:
                          teamViewFilter === "all"
                            ? "1px solid var(--green-mid)"
                            : "1px solid var(--border-md)",
                        background: teamViewFilter === "all" ? "var(--green-light)" : "var(--bg-secondary)",
                        color: teamViewFilter === "all" ? "var(--green-mid)" : "var(--text-secondary)",
                        fontSize: "12px",
                        fontWeight: 500,
                        fontFamily: "inherit",
                        padding: "8px 14px",
                        borderRadius: "999px",
                        cursor: "pointer",
                      }}
                    >
                      All businesses
                    </button>
                    <button
                      type="button"
                      onClick={() => setTeamViewFilter("single")}
                      style={{
                        border:
                          teamViewFilter === "single"
                            ? "1px solid var(--green-mid)"
                            : "1px solid var(--border-md)",
                        background:
                          teamViewFilter === "single" ? "var(--green-light)" : "var(--bg-secondary)",
                        color:
                          teamViewFilter === "single" ? "var(--green-mid)" : "var(--text-secondary)",
                        fontSize: "12px",
                        fontWeight: 500,
                        fontFamily: "inherit",
                        padding: "8px 14px",
                        borderRadius: "999px",
                        cursor: "pointer",
                      }}
                    >
                      One business
                    </button>
                  </div>
                  {teamViewFilter === "single" ? (
                    <div>
                      <div
                        style={{
                          fontSize: "11px",
                          color: "var(--text-tertiary)",
                          marginBottom: "6px",
                        }}
                      >
                        Filter to
                      </div>
                      <PageBusinessSelector
                        selectedBusiness={
                          portfolioBusinessList.find((b) => b.id === teamViewBusinessId) ??
                          portfolioBusinessList[0]!
                        }
                        onSelect={(b) => {
                          setTeamViewBusinessId(b.id);
                          setTeamViewFilter("single");
                        }}
                      />
                    </div>
                  ) : null}
                </div>
              ) : null}

              <div
                style={{
                  border: "0.5px solid var(--border)",
                  borderRadius: "var(--radius-lg)",
                  overflow: "hidden",
                  background: "var(--bg-primary)",
                }}
              >
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "0.6fr 1.8fr 1fr 1.6fr 0.8fr 0.9fr",
                    gap: "12px",
                    padding: "12px 16px",
                    borderBottom: "0.5px solid var(--border)",
                    fontSize: "11px",
                    fontWeight: 500,
                    color: "var(--text-tertiary)",
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                  }}
                >
                  <span>Avatar</span>
                  <span>Name + email</span>
                  <span>Role</span>
                  <span>Business access</span>
                  <span>Status</span>
                  <span>Actions</span>
                </div>
                {displayedTeamMembers.map((row, i) => (
                  <div
                    key={row.email}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "0.6fr 1.8fr 1fr 1.6fr 0.8fr 0.9fr",
                      gap: "12px",
                      padding: "14px 16px",
                      alignItems: "center",
                      fontSize: "13px",
                      borderTop:
                        i > 0 ? "0.5px solid var(--border)" : undefined,
                    }}
                  >
                    <span
                      style={{
                        width: "28px",
                        height: "28px",
                        borderRadius: "50%",
                        background: "var(--bg-secondary)",
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: "11px",
                        color: "var(--text-secondary)",
                        fontWeight: 600,
                      }}
                    >
                      {row.name.split(" ").map((n) => n[0]).join("").slice(0, 2).toUpperCase()}
                    </span>
                    <div>
                      <div style={{ fontWeight: 500, color: "var(--text-primary)", fontSize: "13px" }}>{row.name}</div>
                      <div style={{ color: "var(--text-secondary)", fontSize: "12px", marginTop: "2px" }}>{row.email}</div>
                    </div>
                    <div style={{ position: "relative" }}>
                      {canManageUsers ? (
                        <>
                          <button
                            type="button"
                            onClick={() => setOpenRoleMenuId((v) => (v === row.id ? null : row.id))}
                            style={{ ...rolePillStyle(row.role), border: "none", cursor: "pointer", fontFamily: "inherit" }}
                          >
                            {ROLE_META[row.role].label}
                          </button>
                          {openRoleMenuId === row.id ? (
                            <div style={{ position: "absolute", top: "30px", left: 0, background: "var(--bg-primary)", border: "1px solid var(--border-md)", borderRadius: "var(--radius-md)", boxShadow: "0 4px 16px rgba(0,0,0,0.08)", zIndex: 20, minWidth: "160px" }}>
                              {(["owner", "admin", "standard", "viewer"] as const).map((role) => {
                                const ownerExistsElsewhere =
                                  role === "owner" &&
                                  teamMembers.some((m) => m.role === "owner" && m.id !== row.id);
                                return (
                                  <button
                                    key={role}
                                    type="button"
                                    disabled={ownerExistsElsewhere}
                                    onClick={() => {
                                      if (roleRank(role) < roleRank(row.role)) {
                                        setRoleWarningByMember((prev) => ({
                                          ...prev,
                                          [row.id]: `Changing to ${ROLE_META[role].label} will remove access to Integrations, Settings, and branding controls.`,
                                        }));
                                      } else {
                                        setRoleWarningByMember((prev) => ({ ...prev, [row.id]: "" }));
                                      }
                                      updateMemberRole(row.id, role);
                                    }}
                                    style={{ display: "block", width: "100%", border: "none", background: "transparent", padding: "8px 10px", textAlign: "left", fontSize: "12px", color: ownerExistsElsewhere ? "var(--text-tertiary)" : "var(--text-secondary)", cursor: ownerExistsElsewhere ? "not-allowed" : "pointer", fontFamily: "inherit" }}
                                  >
                                    {ROLE_META[role].label}
                                  </button>
                                );
                              })}
                            </div>
                          ) : null}
                          {roleWarningByMember[row.id] ? (
                            <div style={{ position: "absolute", top: "64px", left: 0, background: "var(--amber-light)", color: "var(--amber-mid)", borderRadius: "var(--radius-md)", padding: "8px 10px", fontSize: "11px", minWidth: "220px", zIndex: 21 }}>
                              {roleWarningByMember[row.id]}
                            </div>
                          ) : null}
                        </>
                      ) : (
                        <span style={rolePillStyle(row.role)}>{ROLE_META[row.role].label}</span>
                      )}
                    </div>
                    <div style={{ position: "relative" }}>
                      {row.role === "owner" || row.role === "admin" ? (
                        <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>All businesses</span>
                      ) : (
                        <>
                          {canManageUsers ? (
                            <>
                              <button
                                type="button"
                                onClick={() => {
                                  setOpenAccessMenuId((v) => (v === row.id ? null : row.id));
                                  setDraftBusinessAccessByMember((prev) => ({
                                    ...prev,
                                    [row.id]: row.businessAccess,
                                  }));
                                }}
                                style={{ border: "none", background: "transparent", padding: 0, cursor: "pointer", fontFamily: "inherit", display: "flex", gap: "6px", flexWrap: "wrap" }}
                              >
                                {row.businessAccess.map((id) => {
                                  const biz = portfolioBusinessList.find((b) => b.id === id);
                                  if (!biz) return null;
                                  return (
                                    <span key={id} style={{ fontSize: "11px", borderRadius: "999px", padding: "2px 8px", background: biz.id === "1" ? "var(--green-light)" : "var(--purple-light)", color: biz.id === "1" ? "var(--green-mid)" : "var(--purple-mid)", fontWeight: 500 }}>
                                      {biz.name}
                                    </span>
                                  );
                                })}
                              </button>
                              {openAccessMenuId === row.id ? (
                                <div style={{ position: "absolute", top: "30px", left: 0, background: "var(--bg-primary)", border: "1px solid var(--border-md)", borderRadius: "var(--radius-md)", boxShadow: "0 4px 16px rgba(0,0,0,0.08)", zIndex: 20, padding: "8px 10px", minWidth: "180px" }}>
                                  <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "12px", color: "var(--text-secondary)", padding: "4px 0", borderBottom: "0.5px solid var(--border)", marginBottom: "4px" }}>
                                    <input
                                      type="checkbox"
                                      checked={(draftBusinessAccessByMember[row.id] ?? row.businessAccess).length === portfolioBusinessList.length}
                                      onChange={(e) =>
                                        setDraftBusinessAccessByMember((prev) => ({
                                          ...prev,
                                          [row.id]: e.target.checked ? portfolioBusinessList.map((b) => b.id) : [],
                                        }))
                                      }
                                    />
                                    All businesses
                                  </label>
                                  {portfolioBusinessList.map((b) => (
                                    <label key={b.id} style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "12px", color: "var(--text-secondary)", padding: "4px 0" }}>
                                      <input
                                        type="checkbox"
                                        checked={(draftBusinessAccessByMember[row.id] ?? row.businessAccess).includes(b.id)}
                                        onChange={() => toggleMemberBusinessAccess(row.id, b.id)}
                                      />
                                      {b.name}
                                    </label>
                                  ))}
                                  <button
                                    type="button"
                                    onClick={() => {
                                      const nextAccess = draftBusinessAccessByMember[row.id] ?? row.businessAccess;
                                      setTeamMembers((prev) =>
                                        prev.map((m) => (m.id === row.id ? { ...m, businessAccess: nextAccess.length ? nextAccess : m.businessAccess } : m)),
                                      );
                                      setOpenAccessMenuId(null);
                                    }}
                                    style={{ marginTop: "6px", border: "none", background: "var(--green-mid)", color: "#fff", fontSize: "12px", padding: "6px 10px", borderRadius: "var(--radius-md)", cursor: "pointer", fontFamily: "inherit" }}
                                  >
                                    Save
                                  </button>
                                </div>
                              ) : null}
                            </>
                          ) : (
                            <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                              {row.businessAccess.map((id) => {
                                const biz = portfolioBusinessList.find((b) => b.id === id);
                                if (!biz) return null;
                                return (
                                  <span key={id} style={{ fontSize: "11px", borderRadius: "999px", padding: "2px 8px", background: biz.id === "1" ? "var(--green-light)" : "var(--purple-light)", color: biz.id === "1" ? "var(--green-mid)" : "var(--purple-mid)", fontWeight: 500 }}>
                                    {biz.name}
                                  </span>
                                );
                              })}
                            </div>
                          )}
                        </>
                      )}
                    </div>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "6px",
                      }}
                    >
                      <span
                        aria-hidden
                        style={{
                          width: "8px",
                          height: "8px",
                          borderRadius: "50%",
                          background:
                            row.status === "active"
                              ? "var(--green-mid)"
                              : row.status === "invited"
                                ? "var(--amber-mid)"
                                : "var(--coral-mid)",
                        }}
                      />
                      <span style={{ color: "var(--text-secondary)" }}>
                        {row.status === "active"
                          ? "Active"
                          : row.status === "invited"
                            ? "Invited"
                            : "Suspended"}
                      </span>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: "6px", alignItems: "flex-start" }}>
                      <RoleGate permission="canManageUsers">
                        <button
                          type="button"
                          onClick={() => openEditMember(row)}
                          style={{ border: "1px solid var(--border-md)", background: "transparent", padding: "3px 8px", fontSize: "12px", color: "var(--text-secondary)", borderRadius: "var(--radius-md)", cursor: "pointer", textAlign: "left", fontFamily: "inherit" }}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={() => setShowRemoveModal(row.id)}
                          style={{ background: "none", border: "none", padding: 0, fontSize: "12px", color: "var(--coral-mid)", cursor: "pointer", textAlign: "left", fontFamily: "inherit" }}
                        >
                          Remove
                        </button>
                        {row.status === "invited" ? (
                          <button
                            type="button"
                            onClick={() => resendInvite(row.email)}
                            style={{ background: "none", border: "none", padding: 0, fontSize: "12px", color: "var(--green-mid)", cursor: "pointer", textAlign: "left", fontFamily: "inherit" }}
                          >
                            Resend invite
                          </button>
                        ) : null}
                      </RoleGate>
                    </div>
                  </div>
                ))}
              </div>

              <div style={{ marginTop: "16px", border: "0.5px solid var(--border)", borderRadius: "var(--radius-lg)", background: "var(--bg-primary)" }}>
                <button
                  type="button"
                  onClick={() => setShowRolePermissions((v) => !v)}
                  style={{ width: "100%", textAlign: "left", border: "none", background: "transparent", padding: "12px 16px", fontSize: "13px", color: "var(--text-secondary)", cursor: "pointer", fontFamily: "inherit" }}
                >
                  What can each role do? {showRolePermissions ? "▴" : "▾"}
                </button>
                {showRolePermissions ? (
                  <div style={{ borderTop: "0.5px solid var(--border)", padding: "12px 16px" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
                      <thead>
                        <tr>
                          <th style={{ textAlign: "left", paddingBottom: "8px", color: "var(--text-tertiary)" }}>Permission</th>
                          {(["owner", "admin", "standard", "viewer"] as const).map((r) => (
                            <th key={r} style={{ textAlign: "center", paddingBottom: "8px", color: "var(--text-tertiary)" }}>{ROLE_META[r].label}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {([
                          ["canManageUsers", "Manage users"],
                          ["canConnectIntegrations", "Connect integrations"],
                          ["canConfigureAI", "Configure AI"],
                          ["canManageBranding", "Manage branding"],
                          ["canExportData", "Export data"],
                          ["canViewAllBusinesses", "View all businesses"],
                          ["canEditBusinesses", "Edit businesses"],
                          ["canManageBilling", "Manage billing"],
                        ] as const).map(([perm, label]) => (
                          <tr key={perm}>
                            <td style={{ padding: "8px 0", color: "var(--text-secondary)" }}>{label}</td>
                            {(["owner", "admin", "standard", "viewer"] as const).map((r) => (
                              <td key={r} style={{ textAlign: "center", color: ROLE_PERMISSIONS[r][perm as keyof RolePermissions] ? "var(--green-mid)" : "var(--text-tertiary)" }}>
                                {ROLE_PERMISSIONS[r][perm as keyof RolePermissions] ? "✓" : "×"}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}

          {activeTab === "notifications" ? (
            <div style={{ maxWidth: "720px" }}>
              <section style={{ marginBottom: "32px" }}>
                <h2
                  style={{
                    margin: "0 0 4px",
                    fontSize: "14px",
                    fontWeight: 500,
                    color: "var(--text-primary)",
                  }}
                >
                  Smart alerts & in-app notifications
                </h2>
                <p
                  style={{
                    margin: "0 0 16px",
                    fontSize: "13px",
                    color: "var(--text-secondary)",
                    lineHeight: 1.45,
                  }}
                >
                  Choose which automated alert types appear in Opal and which can send email. Daily digest
                  rolls up highlights once per day.
                </p>
                {(
                  [
                    {
                      cat: "alerts" as const,
                      title: "Alerts",
                      desc: "Revenue changes, unusual expenses, and other anomaly alerts.",
                    },
                    {
                      cat: "goals" as const,
                      title: "Goals",
                      desc: "Goal pace, milestones, and targets that need attention.",
                    },
                    {
                      cat: "integrations" as const,
                      title: "Integrations",
                      desc: "Sync failures and connection issues (e.g. accounting tools).",
                    },
                    {
                      cat: "aiInsights" as const,
                      title: "AI insights",
                      desc: "Positive milestones and AI-generated summaries.",
                    },
                  ] satisfies { cat: NotificationPrefsCategory; title: string; desc: string }[]
                ).map((row) => (
                  <div
                    key={row.cat}
                    style={{
                      background: "var(--bg-primary)",
                      border: "0.5px solid var(--border)",
                      borderRadius: "var(--radius-lg)",
                      padding: "16px 20px",
                      marginBottom: "8px",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        flexWrap: "wrap",
                        alignItems: "flex-start",
                        justifyContent: "space-between",
                        gap: "16px",
                      }}
                    >
                      <div style={{ minWidth: 0, flex: "1 1 200px" }}>
                        <div
                          style={{
                            fontSize: "14px",
                            fontWeight: 500,
                            color: "var(--text-primary)",
                            marginBottom: "4px",
                          }}
                        >
                          {row.title}
                        </div>
                        <div
                          style={{
                            fontSize: "12px",
                            color: "var(--text-secondary)",
                            lineHeight: 1.45,
                          }}
                        >
                          {row.desc}
                        </div>
                      </div>
                      <div
                        style={{
                          display: "flex",
                          flexWrap: "wrap",
                          alignItems: "center",
                          gap: "20px",
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                          <span style={{ fontSize: "12px", color: "var(--text-secondary)", width: "52px" }}>
                            In-app
                          </span>
                          <ToggleSwitch
                            checked={smartNotifPrefs[row.cat].inApp}
                            ariaLabel={`${row.title} in-app notifications`}
                            onChange={(next) =>
                              setSmartNotifPrefs((p) => ({
                                ...p,
                                [row.cat]: { ...p[row.cat], inApp: next },
                              }))
                            }
                          />
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                          <span style={{ fontSize: "12px", color: "var(--text-secondary)", width: "52px" }}>
                            Email
                          </span>
                          <ToggleSwitch
                            checked={smartNotifPrefs[row.cat].email}
                            ariaLabel={`${row.title} email notifications`}
                            disabled={!notifEmailEnabled}
                            onChange={(next) =>
                              setSmartNotifPrefs((p) => ({
                                ...p,
                                [row.cat]: { ...p[row.cat], email: next },
                              }))
                            }
                          />
                        </div>
                      </div>
                    </div>
                  </div>
                ))}

                <div
                  style={{
                    background: "var(--bg-primary)",
                    border: "0.5px solid var(--border)",
                    borderRadius: "var(--radius-lg)",
                    padding: "16px 20px",
                    marginBottom: "8px",
                    display: "flex",
                    flexWrap: "wrap",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: "16px",
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: "14px",
                        fontWeight: 500,
                        color: "var(--text-primary)",
                        marginBottom: "4px",
                      }}
                    >
                      Daily digest email
                    </div>
                    <div style={{ fontSize: "12px", color: "var(--text-secondary)", lineHeight: 1.45 }}>
                      One summary email per day when there is activity you care about.
                    </div>
                  </div>
                  <ToggleSwitch
                    checked={smartNotifPrefs.dailyDigestEmail}
                    ariaLabel="Daily digest email"
                    disabled={!notifEmailEnabled}
                    onChange={(next) =>
                      setSmartNotifPrefs((p) => ({ ...p, dailyDigestEmail: next }))
                    }
                  />
                </div>

                <div
                  style={{
                    background: "var(--bg-primary)",
                    border: "0.5px solid var(--border)",
                    borderRadius: "var(--radius-lg)",
                    padding: "16px 20px",
                    marginBottom: "8px",
                    display: "flex",
                    flexWrap: "wrap",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: "16px",
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: "14px",
                        fontWeight: 500,
                        color: "var(--text-primary)",
                        marginBottom: "4px",
                      }}
                    >
                      Daily Pulse email
                    </div>
                    <div style={{ fontSize: "12px", color: "var(--text-secondary)", lineHeight: 1.45 }}>
                      Morning portfolio summary with KPIs, one insight, and a recommended action (from
                      info@myopal.io).
                    </div>
                  </div>
                  <ToggleSwitch
                    checked={dailyPulseEmailEnabled}
                    ariaLabel="Daily Pulse email"
                    disabled={!notifEmailEnabled}
                    onChange={setDailyPulseEmailEnabled}
                  />
                </div>

                <div
                  style={{
                    background: "var(--bg-primary)",
                    border: "0.5px solid var(--border)",
                    borderRadius: "var(--radius-lg)",
                    padding: "16px 20px",
                    marginBottom: "8px",
                    display: "flex",
                    flexWrap: "wrap",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: "16px",
                    opacity: 0.85,
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: "14px",
                        fontWeight: 500,
                        color: "var(--text-primary)",
                        marginBottom: "4px",
                      }}
                    >
                      Push notifications
                    </div>
                    <div style={{ fontSize: "12px", color: "var(--text-secondary)", lineHeight: 1.45 }}>
                      Mobile and browser push — reserved for a future release.
                    </div>
                  </div>
                  <ToggleSwitch
                    checked={smartNotifPrefs.pushNotifications}
                    ariaLabel="Push notifications"
                    disabled
                    onChange={() => {}}
                  />
                </div>
              </section>

              <section>
                <h2
                  style={{
                    margin: "0 0 4px",
                    fontSize: "14px",
                    fontWeight: 500,
                    color: "var(--text-primary)",
                  }}
                >
                  Delivery channels
                </h2>
                <p
                  style={{
                    margin: "0 0 20px",
                    fontSize: "13px",
                    color: "var(--text-secondary)",
                    lineHeight: 1.45,
                  }}
                >
                  Choose where Opal sends your notifications
                </p>

                {showDeliveryBanner ? (
                  <div
                    style={{
                      marginBottom: "12px",
                      background: "var(--amber-light)",
                      color: "var(--amber-mid)",
                      borderRadius: "var(--radius-md)",
                      padding: "12px 16px",
                      display: "flex",
                      alignItems: "flex-start",
                      justifyContent: "space-between",
                      gap: "12px",
                    }}
                  >
                    <span style={{ fontSize: "13px", lineHeight: 1.45 }}>
                      Some notification channels need to be connected first.{" "}
                      <Link
                        href="/dashboard/integrations"
                        style={{ color: "var(--amber-mid)", fontWeight: 500 }}
                      >
                        Go to Integrations →
                      </Link>
                    </span>
                    <button
                      type="button"
                      onClick={() => setDismissedDeliveryBanner(true)}
                      aria-label="Dismiss integrations banner"
                      style={{
                        border: "none",
                        background: "transparent",
                        color: "var(--amber-mid)",
                        cursor: "pointer",
                        fontSize: "16px",
                        lineHeight: 1,
                        padding: 0,
                      }}
                    >
                      ×
                    </button>
                  </div>
                ) : null}

                {([
                  {
                    key: "inapp",
                    initial: "I",
                    color: "var(--green-mid)",
                    name: "In-app",
                    desc: "Alerts inside Opal while you work.",
                    state: "connected" as const,
                    checked: true,
                    disabled: true,
                    statusLabel: "Connected",
                    statusColor: "var(--green-mid)",
                    detail: "Always enabled",
                  },
                  {
                    key: "email",
                    initial: "E",
                    color: "#185FA5",
                    name: "Email",
                    desc: "Send notifications to your inbox.",
                    state: "connected" as const,
                    checked: notifEmailEnabled,
                    disabled: false,
                    statusLabel: "Connected",
                    statusColor: "var(--green-mid)",
                    detail: notifEmailAddress || user.email || "Connected email",
                  },
                  {
                    key: "sms",
                    initial: "M",
                    color: "var(--green-mid)",
                    name: "SMS / Text",
                    desc: "Text messages for time-sensitive alerts.",
                    state: "coming_soon" as const,
                    checked: false,
                    disabled: true,
                    statusLabel: "Coming soon",
                    statusColor: "var(--text-tertiary)",
                    detail: "SMS notifications via Twilio — coming soon",
                  },
                  {
                    key: "phone",
                    initial: "P",
                    color: "var(--purple-mid)",
                    name: "Phone call",
                    desc: "Automated voice calls for critical issues.",
                    state: "coming_soon" as const,
                    checked: false,
                    disabled: true,
                    statusLabel: "Coming soon",
                    statusColor: "var(--text-tertiary)",
                    detail: "Phone call alerts — coming soon",
                  },
                  {
                    key: "slack",
                    initial: "S",
                    color: "#4A154B",
                    name: "Slack",
                    desc: "Post updates to Slack.",
                    state: slackConnected ? ("connected" as const) : ("not_connected" as const),
                    checked: slackConnected ? notifSlackEnabled : false,
                    disabled: !slackConnected,
                    statusLabel: slackConnected ? "Connected" : "Not connected",
                    statusColor: slackConnected ? "var(--green-mid)" : "var(--text-tertiary)",
                    detail: slackConnected
                      ? "Connected to Slack workspace"
                      : "Connect Slack in Integrations to enable this channel",
                  },
                  {
                    key: "teams",
                    initial: "T",
                    color: "#6264A7",
                    name: "Microsoft Teams",
                    desc: "Post updates in Microsoft Teams.",
                    state: "coming_soon" as const,
                    checked: false,
                    disabled: true,
                    statusLabel: "Coming soon",
                    statusColor: "var(--text-tertiary)",
                    detail: "Teams notifications — coming soon",
                  },
                  {
                    key: "google-chat",
                    initial: "G",
                    color: "var(--coral-mid)",
                    name: "Google Chat",
                    desc: "Post updates in Google Chat.",
                    state: "coming_soon" as const,
                    checked: false,
                    disabled: true,
                    statusLabel: "Coming soon",
                    statusColor: "var(--text-tertiary)",
                    detail: "Google Chat notifications — coming soon",
                  },
                  {
                    key: "google-workspace",
                    initial: "GW",
                    color: "var(--purple-mid)",
                    name: "Google Workspace",
                    desc: "Send notifications via Gmail.",
                    state: googleWorkspaceConnected
                      ? ("connected" as const)
                      : ("not_connected" as const),
                    checked: googleWorkspaceConnected ? notifGoogleWorkspaceEnabled : false,
                    disabled: !googleWorkspaceConnected,
                    statusLabel: googleWorkspaceConnected ? "Connected" : "Not connected",
                    statusColor: googleWorkspaceConnected
                      ? "var(--green-mid)"
                      : "var(--text-tertiary)",
                    detail: googleWorkspaceConnected
                      ? "Connected — notifications via Gmail"
                      : "Connect Google Workspace in Integrations to enable this channel",
                  },
                ] as const).map((ch) => (
                  <div
                    key={ch.key}
                    style={{
                      background: "var(--bg-primary)",
                      border: "0.5px solid var(--border)",
                      borderRadius: "var(--radius-lg)",
                      padding: "16px 20px",
                      marginBottom: "8px",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "flex-start",
                        justifyContent: "space-between",
                        gap: "16px",
                      }}
                    >
                      <div style={{ display: "flex", gap: "14px", minWidth: 0, flex: 1 }}>
                        <div
                          style={{
                            width: "36px",
                            height: "36px",
                            borderRadius: "50%",
                            background: ch.color,
                            color: "#ffffff",
                            fontSize: "13px",
                            fontWeight: 600,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            flexShrink: 0,
                          }}
                        >
                          {ch.initial}
                        </div>
                        <div style={{ minWidth: 0 }}>
                          <div
                            style={{
                              fontSize: "14px",
                              fontWeight: 500,
                              color: "var(--text-primary)",
                              marginBottom: "4px",
                            }}
                          >
                            {ch.name}
                          </div>
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: "6px",
                              marginBottom: "4px",
                            }}
                          >
                            <span
                              aria-hidden
                              style={{
                                width: "8px",
                                height: "8px",
                                borderRadius: "50%",
                                background:
                                  ch.state === "connected"
                                    ? "var(--green-mid)"
                                    : "var(--text-tertiary)",
                              }}
                            />
                            {ch.state === "coming_soon" ? (
                              <ComingSoonBadge />
                            ) : (
                              <span
                                style={{
                                  fontSize: "12px",
                                  fontWeight: 500,
                                  color: ch.statusColor,
                                }}
                              >
                                {ch.statusLabel}
                              </span>
                            )}
                          </div>
                          <div
                            style={{
                              fontSize: "12px",
                              color: "var(--text-secondary)",
                              lineHeight: 1.45,
                            }}
                          >
                            {ch.desc}
                          </div>
                          <div
                            style={{
                              marginTop: "6px",
                              fontSize: "12px",
                              color: ch.state === "connected" ? "var(--text-secondary)" : "var(--text-tertiary)",
                              fontStyle: ch.state === "not_connected" || ch.state === "coming_soon" ? "italic" : "normal",
                            }}
                          >
                            {ch.detail}
                          </div>
                          {ch.state === "not_connected" ? (
                            <Link
                              href={
                                ch.key === "slack"
                                  ? "/dashboard/integrations?highlight=slack"
                                  : "/dashboard/integrations?highlight=google-workspace"
                              }
                              style={{
                                display: "inline-block",
                                marginTop: "10px",
                                padding: "8px 14px",
                                borderRadius: "var(--radius-md)",
                                border: "1px solid var(--green-mid)",
                                background: "transparent",
                                color: "var(--green-mid)",
                                fontSize: "13px",
                                fontWeight: 500,
                                textDecoration: "none",
                              }}
                            >
                              {ch.key === "slack"
                                ? "Connect Slack in Integrations →"
                                : "Connect Google Workspace in Integrations →"}
                            </Link>
                          ) : null}
                        </div>
                      </div>
                      <ToggleSwitch
                        checked={ch.checked}
                        disabled={ch.disabled}
                        ariaLabel={`${ch.name} notifications`}
                        onChange={(next) => {
                          if (ch.key === "email") setNotifEmailEnabled(next);
                          if (ch.key === "slack") setNotifSlackEnabled(next);
                          if (ch.key === "google-workspace") {
                            setNotifGoogleWorkspaceEnabled(next);
                          }
                        }}
                      />
                    </div>
                  </div>
                ))}
              </section>

              <section style={{ marginTop: "32px" }}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    justifyContent: "space-between",
                    gap: "16px",
                    marginBottom: "16px",
                    flexWrap: "wrap",
                  }}
                >
                  <div>
                    <h2
                      style={{
                        margin: 0,
                        fontSize: "14px",
                        fontWeight: 500,
                        color: "var(--text-primary)",
                      }}
                    >
                      Notification rules
                    </h2>
                    <p
                      style={{
                        margin: "6px 0 0",
                        fontSize: "13px",
                        color: "var(--text-secondary)",
                        lineHeight: 1.45,
                        maxWidth: "520px",
                      }}
                    >
                      Build your own rules — choose what triggers a notification and where it gets sent
                    </p>
                  </div>
                  <RoleGate permission="canManageUsers">
                    <button
                      type="button"
                      onClick={addNotificationRule}
                      style={{
                        border: "none",
                        background: "var(--green-mid)",
                        color: "#ffffff",
                        fontSize: "13px",
                        fontWeight: 500,
                        fontFamily: "inherit",
                        padding: "10px 18px",
                        borderRadius: "var(--radius-md)",
                        cursor: "pointer",
                        flexShrink: 0,
                      }}
                    >
                      Add rule
                    </button>
                  </RoleGate>
                </div>

                {notificationRules.length === 0 ? (
                  <div
                    style={{
                      textAlign: "center",
                      padding: "40px 24px",
                      border: "0.5px dashed var(--border-md)",
                      borderRadius: "var(--radius-lg)",
                      background: "var(--bg-primary)",
                    }}
                  >
                    <p style={{ margin: 0, fontSize: "13px", color: "var(--text-tertiary)" }}>
                      No notification rules yet. Add your first rule to get started.
                    </p>
                    <RoleGate permission="canManageUsers">
                      <button
                        type="button"
                        onClick={addNotificationRule}
                        style={{
                          marginTop: "14px",
                          border: "none",
                          background: "var(--green-mid)",
                          color: "#ffffff",
                          fontSize: "13px",
                          fontWeight: 500,
                          fontFamily: "inherit",
                          padding: "10px 18px",
                          borderRadius: "var(--radius-md)",
                          cursor: "pointer",
                        }}
                      >
                        Add rule
                      </button>
                    </RoleGate>
                  </div>
                ) : (
                  notificationRules.map((rule) => {
                    const triggerMeta = TRIGGER_OPTIONS.find((o) => o.value === rule.trigger);
                    const showX = Boolean(triggerMeta?.hasX);
                    return (
                      <div
                        key={rule.id}
                        style={{
                          background: "var(--bg-primary)",
                          border: "0.5px solid var(--border)",
                          borderRadius: "var(--radius-lg)",
                          padding: "16px 20px",
                          marginBottom: "8px",
                          position: "relative",
                        }}
                      >
                        {!canEditNotificationRules ? (
                          <div
                            style={{
                              position: "absolute",
                              top: 12,
                              right: 12,
                              fontSize: "14px",
                              color: "var(--amber-mid)",
                            }}
                          >
                            🔒
                          </div>
                        ) : null}
                        <div
                          style={{
                            display: "grid",
                            gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
                            gap: "20px",
                            alignItems: "start",
                            opacity: canEditNotificationRules ? 1 : 0.7,
                            pointerEvents: canEditNotificationRules ? "auto" : "none",
                          }}
                        >
                          <div style={{ minWidth: 0 }}>
                            <div style={ruleSectionLabel}>When</div>
                            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "8px" }}>
                              <select
                                value={rule.trigger}
                                onChange={(e) => {
                                  const v = e.target.value as NotificationTriggerValue;
                                  patchNotificationRule(rule.id, {
                                    trigger: v,
                                    triggerValue:
                                      v === "revenue_drop" || v === "expense_pct" ? 20 : rule.triggerValue,
                                  });
                                }}
                                style={{ ...selectRuleStyle, flex: "1 1 140px", minWidth: "140px" }}
                              >
                                <option value="">Select trigger…</option>
                                {TRIGGER_OPTIONS.map((o) => (
                                  <option key={o.value} value={o.value}>
                                    {o.label}
                                  </option>
                                ))}
                              </select>
                              {showX ? (
                                <input
                                  type="number"
                                  min={0}
                                  value={rule.triggerValue}
                                  onChange={(e) =>
                                    patchNotificationRule(rule.id, {
                                      triggerValue: Number(e.target.value) || 0,
                                    })
                                  }
                                  style={{
                                    ...inputStyle,
                                    width: "72px",
                                    flexShrink: 0,
                                  }}
                                />
                              ) : null}
                            </div>
                            {rule.trigger === "custom" ? (
                              <input
                                type="text"
                                placeholder="Describe your custom trigger…"
                                value={rule.customDetail}
                                onChange={(e) =>
                                  patchNotificationRule(rule.id, {
                                    customDetail: e.target.value,
                                  })
                                }
                                style={{ ...inputStyle, marginTop: "10px" }}
                              />
                            ) : null}
                          </div>

                          <div style={{ minWidth: 0 }}>
                            <div style={ruleSectionLabel}>For</div>
                            <select
                              value={rule.businessScope}
                              onChange={(e) =>
                                patchNotificationRule(rule.id, {
                                  businessScope: e.target.value,
                                })
                              }
                              style={selectRuleStyle}
                            >
                              <option value="all">All businesses</option>
                              {portfolioBusinessList.map((b) => (
                                <option key={b.id} value={b.id}>
                                  {b.name}
                                </option>
                              ))}
                            </select>
                          </div>

                          <div style={{ minWidth: 0 }}>
                            <div style={ruleSectionLabel}>Send to</div>
                            <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
                              {RULE_CHANNELS.map((ch) => {
                                const active = rule.channels[ch.id];
                                return (
                                  <button
                                    key={ch.id}
                                    type="button"
                                    title={ch.comingSoon ? "Coming soon" : undefined}
                                    onClick={() =>
                                      patchNotificationRule(rule.id, {
                                        channels: {
                                          ...rule.channels,
                                          [ch.id]: !rule.channels[ch.id],
                                        },
                                      })
                                    }
                                    style={{
                                      border: active ? "1px solid var(--green-mid)" : "1px solid var(--border-md)",
                                      background: active ? "var(--green-light)" : "var(--bg-secondary)",
                                      color: active ? "var(--green-mid)" : "var(--text-tertiary)",
                                      fontSize: "12px",
                                      fontWeight: 500,
                                      fontFamily: "inherit",
                                      padding: "6px 12px",
                                      borderRadius: "999px",
                                      cursor: "pointer",
                                      opacity: ch.comingSoon ? 0.72 : 1,
                                    }}
                                  >
                                    {ch.label}
                                  </button>
                                );
                              })}
                            </div>
                          </div>

                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "flex-end",
                              gap: "12px",
                              flexWrap: "wrap",
                            }}
                          >
                            {!rule.saved ? (
                              <button
                                type="button"
                                onClick={() => saveDraftRule(rule.id)}
                                style={{
                                  border: "none",
                                  background: "var(--green-mid)",
                                  color: "#ffffff",
                                  fontSize: "13px",
                                  fontWeight: 500,
                                  fontFamily: "inherit",
                                  padding: "8px 14px",
                                  borderRadius: "var(--radius-md)",
                                  cursor: "pointer",
                                }}
                              >
                                Save rule
                              </button>
                            ) : null}
                            <ToggleSwitch
                              checked={rule.enabled}
                              ariaLabel="Rule enabled"
                              onChange={(on) => patchNotificationRule(rule.id, { enabled: on })}
                            />
                            <button
                              type="button"
                              onClick={() => deleteNotificationRule(rule.id)}
                              aria-label="Delete rule"
                              style={{
                                border: "none",
                                background: "transparent",
                                padding: "6px",
                                cursor: "pointer",
                                display: "inline-flex",
                                alignItems: "center",
                                justifyContent: "center",
                                borderRadius: "var(--radius-md)",
                              }}
                            >
                              <TrashRuleIcon />
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })
                )}
              </section>

              <section style={{ marginTop: "32px" }}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    justifyContent: "space-between",
                    gap: "16px",
                    marginBottom: "16px",
                    flexWrap: "wrap",
                  }}
                >
                  <div>
                    <h2
                      style={{
                        margin: 0,
                        fontSize: "14px",
                        fontWeight: 500,
                        color: "var(--text-primary)",
                      }}
                    >
                      Alert thresholds
                    </h2>
                    <p
                      style={{
                        margin: "6px 0 0",
                        fontSize: "13px",
                        color: "var(--text-secondary)",
                        lineHeight: 1.45,
                        maxWidth: "520px",
                      }}
                    >
                      Set custom conditions that trigger urgent alerts — for any metric, any business
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={addAlertThreshold}
                    style={{
                      border: "none",
                      background: "var(--green-mid)",
                      color: "#ffffff",
                      fontSize: "13px",
                      fontWeight: 500,
                      fontFamily: "inherit",
                      padding: "10px 18px",
                      borderRadius: "var(--radius-md)",
                      cursor: "pointer",
                      flexShrink: 0,
                    }}
                  >
                    Add threshold
                  </button>
                </div>

                {alertThresholds.length === 0 ? (
                  <div
                    style={{
                      textAlign: "center",
                      padding: "40px 24px",
                      border: "0.5px dashed var(--border-md)",
                      borderRadius: "var(--radius-lg)",
                      background: "var(--bg-primary)",
                    }}
                  >
                    <p style={{ margin: 0, fontSize: "13px", color: "var(--text-tertiary)" }}>
                      No thresholds set. Add your first threshold to get alerted when something needs attention.
                    </p>
                    <button
                      type="button"
                      onClick={addAlertThreshold}
                      style={{
                        marginTop: "14px",
                        border: "none",
                        background: "var(--green-mid)",
                        color: "#ffffff",
                        fontSize: "13px",
                        fontWeight: 500,
                        fontFamily: "inherit",
                        padding: "10px 18px",
                        borderRadius: "var(--radius-md)",
                        cursor: "pointer",
                      }}
                    >
                      Add threshold
                    </button>
                  </div>
                ) : (
                  alertThresholds.map((th) => {
                    const { prefix: thPrefix, suffix: thSuffix } = thresholdValueAffix(th.metric);
                    return (
                      <div
                        key={th.id}
                        style={{
                          background: "var(--bg-primary)",
                          border: "0.5px solid var(--border)",
                          borderRadius: "var(--radius-lg)",
                          padding: "16px 20px",
                          marginBottom: "8px",
                        }}
                      >
                        <div
                          style={{
                            display: "grid",
                            gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
                            gap: "20px",
                            alignItems: "start",
                          }}
                        >
                          <div style={{ minWidth: 0 }}>
                            <div style={ruleSectionLabel}>Alert me when</div>
                            <select
                              value={th.metric}
                              onChange={(e) => {
                                const v = e.target.value as ThresholdMetric;
                                patchAlertThreshold(th.id, {
                                  metric: v,
                                  value: v ? defaultValueForThresholdMetric(v) : 0,
                                });
                              }}
                              style={selectRuleStyle}
                            >
                              <option value="">Select metric…</option>
                              {THRESHOLD_METRIC_OPTIONS.map((o) => (
                                <option key={o.value} value={o.value}>
                                  {o.label}
                                </option>
                              ))}
                            </select>
                            {th.metric === "custom" ? (
                              <input
                                type="text"
                                placeholder="Describe your custom metric…"
                                value={th.customDetail}
                                onChange={(e) =>
                                  patchAlertThreshold(th.id, { customDetail: e.target.value })
                                }
                                style={{ ...inputStyle, marginTop: "10px" }}
                              />
                            ) : null}
                          </div>

                          <div style={{ minWidth: 0 }}>
                            <div style={ruleSectionLabel}>Threshold</div>
                            <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                              {thPrefix ? (
                                <span style={{ fontSize: "13px", color: "var(--text-secondary)" }}>{thPrefix}</span>
                              ) : null}
                              <input
                                type="number"
                                min={0}
                                value={th.value}
                                onChange={(e) =>
                                  patchAlertThreshold(th.id, {
                                    value: Number(e.target.value) || 0,
                                  })
                                }
                                style={{
                                  width: "80px",
                                  boxSizing: "border-box",
                                  padding: "10px 12px",
                                  fontSize: "13px",
                                  background: "var(--bg-secondary)",
                                  border: "1px solid var(--border-md)",
                                  borderRadius: "var(--radius-md)",
                                  color: "var(--text-primary)",
                                  fontFamily: "inherit",
                                }}
                              />
                              {thSuffix ? (
                                <span style={{ fontSize: "13px", color: "var(--text-secondary)" }}>{thSuffix}</span>
                              ) : null}
                            </div>
                          </div>

                          <div style={{ minWidth: 0 }}>
                            <div style={ruleSectionLabel}>For</div>
                            <select
                              value={th.businessScope}
                              onChange={(e) =>
                                patchAlertThreshold(th.id, { businessScope: e.target.value })
                              }
                              style={selectRuleStyle}
                            >
                              <option value="all">All businesses</option>
                              {portfolioBusinessList.map((b) => (
                                <option key={b.id} value={b.id}>
                                  {b.name}
                                </option>
                              ))}
                            </select>
                          </div>

                          <div style={{ minWidth: 0 }}>
                            <div style={ruleSectionLabel}>Priority</div>
                            <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
                              {(
                                [
                                  {
                                    id: "low" as const,
                                    label: "Low",
                                    activeBg: "var(--bg-secondary)",
                                    activeColor: "var(--text-secondary)",
                                    activeBorder: "var(--border-md)",
                                  },
                                  {
                                    id: "medium" as const,
                                    label: "Medium",
                                    activeBg: "var(--amber-light)",
                                    activeColor: "var(--amber-mid)",
                                    activeBorder: "var(--amber-mid)",
                                  },
                                  {
                                    id: "high" as const,
                                    label: "High",
                                    activeBg: "var(--coral-light)",
                                    activeColor: "var(--coral-mid)",
                                    activeBorder: "var(--coral-mid)",
                                  },
                                ] as const
                              ).map((p) => {
                                const active = th.priority === p.id;
                                return (
                                  <button
                                    key={p.id}
                                    type="button"
                                    onClick={() => patchAlertThreshold(th.id, { priority: p.id })}
                                    style={{
                                      border: active ? `1px solid ${p.activeBorder}` : "1px solid var(--border-md)",
                                      background: active ? p.activeBg : "var(--bg-secondary)",
                                      color: active ? p.activeColor : "var(--text-tertiary)",
                                      fontSize: "12px",
                                      fontWeight: 500,
                                      fontFamily: "inherit",
                                      padding: "6px 14px",
                                      borderRadius: "999px",
                                      cursor: "pointer",
                                    }}
                                  >
                                    {p.label}
                                  </button>
                                );
                              })}
                            </div>
                          </div>

                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "flex-end",
                              gap: "12px",
                              flexWrap: "wrap",
                            }}
                          >
                            {!th.saved ? (
                              <button
                                type="button"
                                onClick={() => saveDraftThreshold(th.id)}
                                style={{
                                  border: "none",
                                  background: "var(--green-mid)",
                                  color: "#ffffff",
                                  fontSize: "13px",
                                  fontWeight: 500,
                                  fontFamily: "inherit",
                                  padding: "8px 14px",
                                  borderRadius: "var(--radius-md)",
                                  cursor: "pointer",
                                }}
                              >
                                Save threshold
                              </button>
                            ) : null}
                            <ToggleSwitch
                              checked={th.enabled}
                              ariaLabel="Threshold enabled"
                              onChange={(on) => patchAlertThreshold(th.id, { enabled: on })}
                            />
                            <button
                              type="button"
                              onClick={() => deleteAlertThreshold(th.id)}
                              aria-label="Delete threshold"
                              style={{
                                border: "none",
                                background: "transparent",
                                padding: "6px",
                                cursor: "pointer",
                                display: "inline-flex",
                                alignItems: "center",
                                justifyContent: "center",
                                borderRadius: "var(--radius-md)",
                              }}
                            >
                              <TrashRuleIcon />
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })
                )}

                <RoleGate permission="canManageUsers">
                  <button
                    type="button"
                    style={{ ...primaryBtn, marginTop: "24px" }}
                    onClick={async () => {
                      await mergePreferences((p) => ({
                        ...p,
                        notificationPrefs: smartNotifPrefs,
                        notifications: {
                          ...(p.notifications && typeof p.notifications === "object"
                            ? p.notifications
                            : {}),
                          daily_pulse_email: dailyPulseEmailEnabled,
                        },
                      }));
                      logAction("Settings changed", "notifications", "Saved notification preferences", {
                        userId: user.email ?? undefined,
                      });
                    }}
                  >
                    Save notification preferences
                  </button>
                </RoleGate>
              </section>
            </div>
          ) : null}

          {activeTab === "security" ? (
            <SecuritySettingsTab
              securityPeers={teamMembers.map((m) => ({ id: m.id, name: m.name }))}
              autoStartMfaEnrollment={
                searchParams.get("tab") === "security" && searchParams.get("setup") === "true"
              }
            />
          ) : null}

          {activeTab === "billing" ? (
            <div style={{ maxWidth: "960px" }}>
              {subscriptionCancelled ? (
                <div
                  style={{
                    background: "var(--bg-secondary)",
                    borderRadius: "var(--radius-lg)",
                    padding: "18px 20px",
                    marginBottom: "20px",
                    border: "0.5px solid var(--border)",
                    display: "flex",
                    gap: "14px",
                    alignItems: "flex-start",
                  }}
                >
                  <span
                    aria-hidden
                    style={{
                      width: "36px",
                      height: "36px",
                      borderRadius: "50%",
                      background: "var(--green-light)",
                      color: "var(--green-mid)",
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: "18px",
                      flexShrink: 0,
                    }}
                  >
                    ✓
                  </span>
                  <div>
                    <div
                      style={{
                        fontSize: "15px",
                        fontWeight: 500,
                        color: "var(--text-primary)",
                        marginBottom: "6px",
                      }}
                    >
                      Your subscription has been cancelled
                    </div>
                    <p style={{ margin: 0, fontSize: "13px", color: "var(--text-secondary)", lineHeight: 1.5 }}>
                      You&apos;ll have access until {subscriptionCancelled.accessUntilLabel}.
                    </p>
                  </div>
                </div>
              ) : null}
              {billingProfile ? (
                <p
                  style={{
                    margin: "0 0 14px",
                    fontSize: "13px",
                    color: "var(--text-secondary)",
                    lineHeight: 1.5,
                  }}
                >
                  Profile plan: <strong style={{ color: "var(--text-primary)" }}>{billingProfile.plan}</strong>
                  {billingProfile.subscription_status
                    ? ` · Subscription: ${billingProfile.subscription_status}`
                    : null}
                  {billingProfile.trial_ends_at
                    ? ` · Trial ends ${new Date(billingProfile.trial_ends_at).toLocaleDateString("en-US")}`
                    : null}
                  {billingProfile.stripe_customer_id
                    ? ` · Stripe customer ${billingProfile.stripe_customer_id}`
                    : null}
                </p>
              ) : null}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px", marginBottom: "14px", flexWrap: "wrap" }}>
                <h2 style={{ margin: 0, fontSize: "16px", fontWeight: 500, color: "var(--text-primary)" }}>
                  Current plan
                </h2>
                <div style={{ display: "inline-flex", background: "var(--bg-secondary)", borderRadius: "999px", padding: "3px" }}>
                  {(["monthly", "annual"] as const).map((cycle) => {
                    const active = billingCycle === cycle;
                    return (
                      <button
                        key={cycle}
                        type="button"
                        onClick={() => setBillingCycle(cycle)}
                        style={{
                          border: "none",
                          background: active ? "var(--bg-primary)" : "transparent",
                          color: active ? "var(--text-primary)" : "var(--text-secondary)",
                          borderRadius: "999px",
                          padding: "7px 12px",
                          fontSize: "12px",
                          fontWeight: active ? 500 : 400,
                          cursor: "pointer",
                          fontFamily: "inherit",
                        }}
                      >
                        {cycle === "monthly" ? "Monthly" : "Annual"}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div style={{ background: "var(--bg-secondary)", borderRadius: "var(--radius-lg)", padding: "20px", marginBottom: "20px", border: "0.5px solid var(--border)" }}>
                <div style={{ fontSize: "16px", fontWeight: 500, color: "var(--text-primary)", marginBottom: "6px" }}>
                  Operator Plan
                </div>
                <div style={{ fontSize: "22px", fontWeight: 600, color: "var(--green-mid)", marginBottom: "8px" }}>
                  {billingCycle === "annual" ? "$63/mo (billed $756/yr)" : "$79/mo"}
                </div>
                <p style={{ margin: "0 0 16px", fontSize: "13px", color: "var(--text-secondary)", lineHeight: 1.45 }}>
                  2 businesses · Unlimited users · {billingCycle === "annual" ? "Save 20% annually" : "Monthly billing"}
                </p>
                <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                  <button type="button" style={primaryBtn} onClick={() => openBillingAuth("studio")} disabled={billingActionLoading === "upgrade"}>
                    {billingActionLoading === "upgrade" ? "Redirecting..." : "Upgrade to Studio"}
                  </button>
                  <button type="button" onClick={() => openStripePortal("portal")} style={{ border: "0.5px solid var(--border-md)", background: "transparent", color: "var(--text-primary)", borderRadius: "var(--radius-md)", padding: "10px 14px", fontSize: "13px", fontFamily: "inherit", cursor: "pointer" }} disabled={billingActionLoading === "portal"}>
                    {billingActionLoading === "portal" ? "Opening..." : "Manage subscription"}
                  </button>
                </div>
                {!subscriptionCancelled ? (
                  <button
                    type="button"
                    onClick={openCancelModal}
                    style={{
                      marginTop: "14px",
                      border: "none",
                      background: "none",
                      padding: 0,
                      fontSize: "13px",
                      color: "var(--coral-mid)",
                      cursor: "pointer",
                      fontFamily: "inherit",
                      textDecoration: "underline",
                      textUnderlineOffset: "2px",
                    }}
                  >
                    Cancel subscription
                  </button>
                ) : null}
              </div>

              <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "repeat(3, minmax(0, 1fr))", gap: "12px", marginBottom: "20px" }}>
                <div style={{ border: "0.5px solid var(--border)", borderRadius: "var(--radius-lg)", background: "var(--bg-primary)", padding: "18px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
                    <div style={{ fontSize: "16px", fontWeight: 500, color: "var(--text-primary)" }}>Operator</div>
                    <span style={{ fontSize: "11px", borderRadius: "999px", padding: "4px 8px", background: "var(--bg-secondary)", color: "var(--text-secondary)" }}>Your current plan</span>
                  </div>
                  <div style={{ fontSize: "22px", fontWeight: 600, color: "var(--text-primary)" }}>{billingCycle === "annual" ? "$63/mo" : "$79/mo"}</div>
                  <ul style={{ margin: "12px 0 0", padding: 0, listStyle: "none", display: "grid", gap: "6px", fontSize: "12px", color: "var(--text-secondary)" }}>
                    <li>✓ Core dashboard and reporting</li>
                    <li>✓ 2 businesses included</li>
                    <li>✓ Team management</li>
                  </ul>
                </div>
                <div style={{ border: "1px solid var(--green-mid)", borderRadius: "var(--radius-lg)", background: "var(--bg-primary)", padding: "18px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
                    <div style={{ fontSize: "16px", fontWeight: 500, color: "var(--text-primary)" }}>Studio</div>
                    <span style={{ fontSize: "11px", borderRadius: "999px", padding: "4px 8px", background: "var(--green-mid)", color: "#fff" }}>Most popular</span>
                  </div>
                  <div style={{ fontSize: "22px", fontWeight: 600, color: "var(--green-mid)" }}>{billingCycle === "annual" ? "$199/mo" : "$249/mo"}</div>
                  <ul style={{ margin: "12px 0 0", padding: 0, listStyle: "none", display: "grid", gap: "6px", fontSize: "12px", color: "var(--text-secondary)" }}>
                    <li>✓ Unlimited businesses</li>
                    <li>✓ Advanced AI insights</li>
                    <li>✓ Premium integrations</li>
                  </ul>
                  <button type="button" style={{ ...primaryBtn, marginTop: "14px", width: "100%" }} onClick={() => openBillingAuth("studio")} disabled={billingActionLoading === "upgrade"}>
                    Upgrade
                  </button>
                </div>
                <div style={{ border: "0.5px solid var(--border)", borderRadius: "var(--radius-lg)", background: "var(--bg-primary)", padding: "18px" }}>
                  <div style={{ fontSize: "16px", fontWeight: 500, color: "var(--text-primary)", marginBottom: "10px" }}>Enterprise</div>
                  <div style={{ fontSize: "22px", fontWeight: 600, color: "var(--text-primary)" }}>Custom</div>
                  <ul style={{ margin: "12px 0 0", padding: 0, listStyle: "none", display: "grid", gap: "6px", fontSize: "12px", color: "var(--text-secondary)" }}>
                    <li>✓ Dedicated onboarding</li>
                    <li>✓ SSO and security controls</li>
                    <li>✓ Priority support</li>
                  </ul>
                  <button type="button" style={{ marginTop: "14px", width: "100%", border: "0.5px solid var(--border-md)", background: "transparent", color: "var(--text-primary)", borderRadius: "var(--radius-md)", padding: "10px 14px", fontSize: "13px", fontFamily: "inherit", cursor: "pointer" }}>
                    Contact us
                  </button>
                </div>
              </div>

              <h2 style={{ margin: "0 0 12px", fontSize: "13px", fontWeight: 500, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                Billing history
              </h2>
              <div style={{ border: "0.5px solid var(--border)", borderRadius: "var(--radius-lg)", overflow: "hidden", background: "var(--bg-primary)", marginBottom: "20px" }}>
                <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1.2fr 1fr 0.8fr" : "1fr 1.2fr 0.8fr 0.8fr 0.8fr", padding: "12px 16px", fontSize: "11px", color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.05em", borderBottom: "0.5px solid var(--border)" }}>
                  <span>Date</span>
                  {!isMobile ? <span>Description</span> : null}
                  <span>Amount</span>
                  <span>Status</span>
                  {!isMobile ? <span>Invoice</span> : null}
                </div>
                <div style={{ padding: "18px 16px", fontSize: "13px", color: "var(--text-secondary)", lineHeight: 1.5 }}>
                  No invoice history stored in Opal yet. When billing runs through Stripe, entries can be shown here.
                  Use “Manage subscription” to open the Stripe customer portal for receipts.
                </div>
              </div>

              <h2 style={{ margin: "0 0 12px", fontSize: "13px", fontWeight: 500, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                Payment method
              </h2>
              <div style={{ border: "0.5px solid var(--border)", borderRadius: "var(--radius-lg)", background: "var(--bg-primary)", padding: "16px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px", flexWrap: "wrap" }}>
                <div style={{ fontSize: "13px", color: "var(--text-secondary)" }}>
                  Visa ending in 4242, expires 12/27
                </div>
                <button type="button" onClick={() => openStripePortal("payment")} style={{ border: "0.5px solid var(--border-md)", background: "transparent", color: "var(--text-primary)", borderRadius: "var(--radius-md)", padding: "10px 14px", fontSize: "13px", fontFamily: "inherit", cursor: "pointer" }} disabled={billingActionLoading === "payment"}>
                  {billingActionLoading === "payment" ? "Opening..." : "Update payment method"}
                </button>
              </div>

              {cancelModalOpen ? (
                <div
                  role="presentation"
                  onClick={() => {
                    if (cancelPhase === "success") setCancelModalOpen(false);
                  }}
                  style={{
                    position: "fixed",
                    inset: 0,
                    zIndex: 60,
                    background: "rgba(0,0,0,0.45)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    padding: "24px",
                  }}
                >
                  <div
                    role="dialog"
                    aria-modal="true"
                    onClick={(e) => e.stopPropagation()}
                    style={{
                      width: "100%",
                      maxWidth: "440px",
                      background: "var(--bg-primary)",
                      borderRadius: "var(--radius-xl)",
                      padding: "24px",
                      border: "0.5px solid var(--border)",
                    }}
                  >
                    {cancelPhase === "success" ? (
                      <div
                        style={{
                          background: "var(--bg-secondary)",
                          borderRadius: "var(--radius-lg)",
                          padding: "20px",
                          textAlign: "center",
                        }}
                      >
                        <div
                          aria-hidden
                          style={{
                            width: "44px",
                            height: "44px",
                            margin: "0 auto 12px",
                            borderRadius: "50%",
                            background: "var(--green-light)",
                            color: "var(--green-mid)",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            fontSize: "22px",
                          }}
                        >
                          ✓
                        </div>
                        <p style={{ margin: 0, fontSize: "14px", color: "var(--text-primary)", lineHeight: 1.5 }}>
                          Your subscription has been cancelled. You&apos;ll have access until{" "}
                          {billingCycle === "monthly" ? NEXT_BILLING_LABEL : ANNUAL_ACCESS_END_LABEL}.
                        </p>
                        <button
                          type="button"
                          onClick={() => setCancelModalOpen(false)}
                          style={{
                            marginTop: "16px",
                            border: "none",
                            borderRadius: "var(--radius-md)",
                            background: "var(--green-mid)",
                            color: "var(--green-light)",
                            padding: "10px 18px",
                            fontSize: "13px",
                            fontWeight: 600,
                            fontFamily: "inherit",
                            cursor: "pointer",
                          }}
                        >
                          Done
                        </button>
                      </div>
                    ) : (
                      <>
                        <h3
                          style={{
                            margin: "0 0 12px",
                            fontSize: "18px",
                            fontWeight: 500,
                            color: "var(--text-primary)",
                          }}
                        >
                          Cancel your subscription
                        </h3>
                        <p style={{ margin: "0 0 8px", fontSize: "13px", color: "var(--text-secondary)" }}>
                          <strong style={{ color: "var(--text-primary)" }}>Operator Plan</strong> — Next
                          billing: {NEXT_BILLING_LABEL}
                        </p>
                        <p style={{ margin: "0 0 16px", fontSize: "13px", color: "var(--text-secondary)", lineHeight: 1.5 }}>
                          {billingCycle === "monthly" ? (
                            <>
                              Your access continues until {NEXT_BILLING_LABEL}. You won&apos;t be charged
                              again.
                            </>
                          ) : (
                            <>
                              Your access continues until {ANNUAL_ACCESS_END_LABEL}. You won&apos;t be charged
                              again.
                            </>
                          )}
                        </p>
                        <label style={{ ...labelStyle, marginTop: "8px" }}>
                          Why are you cancelling?
                          <select
                            required
                            value={cancelReason}
                            onChange={(e) => setCancelReason(e.target.value)}
                            style={{ ...inputStyle, cursor: "pointer" }}
                          >
                            <option value="">Select a reason</option>
                            {CANCEL_REASON_OPTIONS.map((r) => (
                              <option key={r} value={r}>
                                {r}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label style={{ ...labelStyle, marginTop: "12px" }}>
                          Anything we should know?
                          <textarea
                            value={cancelFeedback}
                            onChange={(e) => setCancelFeedback(e.target.value)}
                            placeholder="Anything we should know?"
                            rows={3}
                            style={{ ...inputStyle, resize: "vertical" }}
                          />
                        </label>
                        {cancelMessage ? (
                          <p
                            role="alert"
                            style={{
                              margin: "12px 0 0",
                              fontSize: "13px",
                              color: "var(--coral-mid, #c44)",
                              lineHeight: 1.5,
                            }}
                          >
                            {cancelMessage}
                          </p>
                        ) : null}
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            gap: "10px",
                            marginTop: "20px",
                            flexWrap: "wrap",
                          }}
                        >
                          <button
                            type="button"
                            onClick={() => setCancelModalOpen(false)}
                            style={{
                              border: "0.5px solid var(--border-md)",
                              background: "transparent",
                              color: "var(--text-primary)",
                              borderRadius: "var(--radius-md)",
                              padding: "10px 16px",
                              fontSize: "13px",
                              fontFamily: "inherit",
                              cursor: "pointer",
                            }}
                          >
                            Keep my subscription
                          </button>
                          <button
                            type="button"
                            disabled={!cancelReason || cancelSubmitting}
                            onClick={() => void confirmSubscriptionCancel()}
                            style={{
                              border: "none",
                              borderRadius: "var(--radius-md)",
                              background: "var(--coral-mid)",
                              color: "#fff",
                              padding: "10px 16px",
                              fontSize: "13px",
                              fontWeight: 600,
                              fontFamily: "inherit",
                              cursor: cancelReason && !cancelSubmitting ? "pointer" : "not-allowed",
                              opacity: cancelReason && !cancelSubmitting ? 1 : 0.55,
                            }}
                          >
                            {cancelSubmitting ? "Cancelling…" : "Confirm cancellation"}
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                </div>
              ) : null}

              {billingAuthOpen ? (
                <div
                  role="presentation"
                  onClick={() => setBillingAuthOpen(false)}
                  style={{
                    position: "fixed",
                    inset: 0,
                    zIndex: 60,
                    background: "rgba(0,0,0,0.45)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    padding: "24px",
                  }}
                >
                  <div
                    role="dialog"
                    aria-modal="true"
                    onClick={(e) => e.stopPropagation()}
                    style={{
                      width: "100%",
                      maxWidth: "460px",
                      background: "var(--bg-primary)",
                      borderRadius: "var(--radius-xl)",
                      padding: "24px",
                      border: "0.5px solid var(--border)",
                    }}
                  >
                    <h3
                      style={{
                        margin: "0 0 12px",
                        fontSize: "18px",
                        fontWeight: 500,
                        color: "var(--text-primary)",
                      }}
                    >
                      Authorize automatic payments
                    </h3>
                    <p style={{ margin: "0 0 16px", fontSize: "13px", color: "var(--text-secondary)", lineHeight: 1.55 }}>
                      {billingCycle === "monthly" ? (
                        <>
                          By subscribing, you authorize automatic monthly charges of $
                          {PLAN_CHECKOUT_AMOUNTS[billingAuthPlan].monthly} to your payment method on{" "}
                          {NEXT_BILLING_LABEL} each month until you cancel.
                        </>
                      ) : (
                        <>
                          By subscribing, you authorize a single annual charge of $
                          {PLAN_CHECKOUT_AMOUNTS[billingAuthPlan].annualCharge.toLocaleString("en-US")} to
                          your payment method. Your subscription renews on {ANNUAL_ACCESS_END_LABEL}{" "}
                          unless cancelled.
                        </>
                      )}
                    </p>
                    <label
                      style={{
                        display: "flex",
                        gap: "10px",
                        alignItems: "flex-start",
                        fontSize: "13px",
                        color: "var(--text-secondary)",
                        cursor: "pointer",
                        marginBottom: "10px",
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={billingAuthAgreed}
                        onChange={(e) => setBillingAuthAgreed(e.target.checked)}
                        style={{ marginTop: "2px", accentColor: "var(--green-mid)" }}
                      />
                      <span>
                        I authorize these automatic payments and agree to the{" "}
                        <a href="#" style={{ color: "var(--green-mid)" }}>
                          Terms of Service
                        </a>{" "}
                        and{" "}
                        <a href="#" style={{ color: "var(--green-mid)" }}>
                          Billing Policy
                        </a>
                      </span>
                    </label>
                    <a
                      href="#"
                      style={{
                        display: "inline-block",
                        fontSize: "13px",
                        color: "var(--green-mid)",
                        marginBottom: "18px",
                      }}
                    >
                      View billing policy →
                    </a>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: "10px", flexWrap: "wrap" }}>
                      <button
                        type="button"
                        onClick={() => setBillingAuthOpen(false)}
                        style={{
                          border: "0.5px solid var(--border-md)",
                          background: "transparent",
                          color: "var(--text-primary)",
                          borderRadius: "var(--radius-md)",
                          padding: "10px 16px",
                          fontSize: "13px",
                          fontFamily: "inherit",
                          cursor: "pointer",
                        }}
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        disabled={!billingAuthAgreed}
                        onClick={confirmBillingAuth}
                        style={{
                          border: "none",
                          borderRadius: "var(--radius-md)",
                          background: "var(--green-mid)",
                          color: "var(--green-light)",
                          padding: "10px 16px",
                          fontSize: "13px",
                          fontWeight: 600,
                          fontFamily: "inherit",
                          cursor: billingAuthAgreed ? "pointer" : "not-allowed",
                          opacity: billingAuthAgreed ? 1 : 0.55,
                        }}
                      >
                        Authorize and continue →
                      </button>
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      {editMemberId && editForm ? (
        <div
          role="presentation"
          onClick={() => {
            setEditMemberId(null);
            setEditForm(null);
          }}
          style={{ position: "fixed", inset: 0, zIndex: 52, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", padding: "24px" }}
        >
          <div role="dialog" onClick={(e) => e.stopPropagation()} style={{ width: "100%", maxWidth: "520px", background: "var(--bg-primary)", borderRadius: "var(--radius-xl)", padding: "24px" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "12px" }}>
              <h3 style={{ margin: 0, fontSize: "18px", fontWeight: 500, color: "var(--text-primary)" }}>
                Edit member — {editForm.name}
              </h3>
              <button type="button" onClick={() => { setEditMemberId(null); setEditForm(null); }} style={{ border: "none", background: "transparent", color: "var(--text-tertiary)", fontSize: "18px", cursor: "pointer" }}>×</button>
            </div>
            <div style={{ display: "flex", justifyContent: "center", marginBottom: "14px" }}>
              <span style={{ width: "48px", height: "48px", borderRadius: "50%", background: ROLE_META[editForm.role].bg, color: ROLE_META[editForm.role].color, display: "inline-flex", alignItems: "center", justifyContent: "center", fontWeight: 600 }}>
                {editForm.name.split(" ").map((n) => n[0]).join("").slice(0, 2).toUpperCase()}
              </span>
            </div>
            <div style={{ display: "grid", gap: "12px" }}>
              <label style={labelStyle}>Full name<input value={editForm.name} onChange={(e) => setEditForm((p) => (p ? { ...p, name: e.target.value } : p))} style={inputStyle} /></label>
              <label style={labelStyle}>Email<input value={editForm.email} onChange={(e) => setEditForm((p) => (p ? { ...p, email: e.target.value } : p))} style={inputStyle} /><div style={{ marginTop: "4px", fontSize: "11px", color: "var(--text-tertiary)", fontStyle: "italic" }}>Changing email will re-send verification</div></label>
              <label style={labelStyle}>
                Role
                <select value={editForm.role} onChange={(e) => setEditForm((p) => (p ? { ...p, role: e.target.value as UserRole, businessAccess: e.target.value === "owner" || e.target.value === "admin" ? portfolioBusinessList.map((b) => b.id) : p.businessAccess } : p))} style={{ ...inputStyle, cursor: "pointer" }}>
                  {(["owner", "admin", "standard", "viewer"] as const).map((role) => {
                    const ownerExistsElsewhere =
                      role === "owner" &&
                      teamMembers.some((m) => m.role === "owner" && m.id !== editMemberId);
                    return (
                      <option key={role} value={role} disabled={ownerExistsElsewhere}>
                        {ROLE_META[role].label} — {ROLE_META[role].description}
                      </option>
                    );
                  })}
                </select>
              </label>
              {(() => {
                const current = teamMembers.find((m) => m.id === editMemberId);
                if (!current) return null;
                const restrictive = roleRank(editForm.role) < roleRank(current.role);
                if (!restrictive) return null;
                return (
                  <div style={{ background: "var(--amber-light)", color: "var(--amber-mid)", borderRadius: "var(--radius-md)", padding: "10px 14px", fontSize: "12px" }}>
                    Changing to {ROLE_META[editForm.role].label} will remove access to Integrations, Settings, and branding controls.
                  </div>
                );
              })()}
              <div>
                <div style={{ fontSize: "12px", fontWeight: 500, color: "var(--text-secondary)", marginBottom: "6px" }}>Business access</div>
                {editForm.role === "owner" || editForm.role === "admin" ? (
                  <div style={{ fontSize: "12px", color: "var(--text-tertiary)" }}>Full access to all businesses</div>
                ) : (
                  <div style={{ display: "grid", gap: "6px" }}>
                    <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", color: "var(--text-secondary)" }}>
                      <input type="checkbox" checked={editForm.businessAccess.length === portfolioBusinessList.length} onChange={(e) => setEditForm((p) => (p ? { ...p, businessAccess: e.target.checked ? portfolioBusinessList.map((b) => b.id) : [] } : p))} style={{ accentColor: "var(--green-mid)" }} />
                      All businesses
                    </label>
                    {portfolioBusinessList.map((b) => (
                      <label key={b.id} style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", color: "var(--text-secondary)" }}>
                        <input type="checkbox" checked={editForm.businessAccess.includes(b.id)} onChange={() => setEditForm((p) => p ? { ...p, businessAccess: p.businessAccess.includes(b.id) ? p.businessAccess.filter((x) => x !== b.id) : [...p.businessAccess, b.id] } : p)} style={{ accentColor: "var(--green-mid)" }} />
                        <span style={{ fontSize: "11px", borderRadius: "999px", padding: "2px 8px", background: b.id === "1" ? "var(--green-light)" : "var(--purple-light)", color: b.id === "1" ? "var(--green-mid)" : "var(--purple-mid)", fontWeight: 500 }}>
                          {b.name}
                        </span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
              <div>
                <div style={{ ...labelStyle, marginBottom: "6px" }}>Status</div>
                <div style={{ display: "flex", gap: "8px" }}>
                  {(["active", "suspended"] as const).map((status) => {
                    const active = editForm.status === status;
                    return (
                      <button key={status} type="button" onClick={() => setEditForm((p) => (p ? { ...p, status } : p))} style={{ border: "none", borderRadius: "999px", padding: "6px 12px", background: active ? "var(--green-light)" : "var(--bg-secondary)", color: active ? "var(--green-mid)" : "var(--text-secondary)", fontSize: "12px", cursor: "pointer", fontFamily: "inherit" }}>
                        {status === "active" ? "Active" : "Suspended"}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "16px" }}>
              <button type="button" onClick={() => setShowRemoveModal(editMemberId)} style={{ border: "none", background: "transparent", color: "var(--coral-mid)", fontSize: "13px", cursor: "pointer", fontFamily: "inherit", padding: 0 }}>
                Remove member
              </button>
              <div style={{ display: "flex", gap: "8px" }}>
                <button type="button" onClick={() => { setEditMemberId(null); setEditForm(null); }} style={{ border: "1px solid var(--border-md)", background: "transparent", color: "var(--text-secondary)", borderRadius: "var(--radius-md)", padding: "8px 12px", cursor: "pointer", fontFamily: "inherit" }}>
                  Cancel
                </button>
                <button type="button" onClick={saveEditedMember} style={{ border: "none", background: "var(--green-mid)", color: "#fff", borderRadius: "var(--radius-md)", padding: "8px 12px", cursor: "pointer", fontFamily: "inherit" }}>
                  Save changes
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {showInviteModal ? (
        <div
          role="presentation"
          onClick={() => setShowInviteModal(false)}
          style={{ position: "fixed", inset: 0, zIndex: 50, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", padding: "24px" }}
        >
          <div
            role="dialog"
            onClick={(e) => e.stopPropagation()}
            style={{ width: "100%", maxWidth: "480px", background: "var(--bg-primary)", borderRadius: "var(--radius-xl)", padding: "24px" }}
          >
            <h3 style={{ margin: "0 0 14px", fontSize: "18px", fontWeight: 500, color: "var(--text-primary)" }}>Invite member</h3>
            <div style={{ display: "grid", gap: "12px" }}>
              <label style={labelStyle}>Full name<input value={inviteForm.name} onChange={(e) => setInviteForm((p) => ({ ...p, name: e.target.value }))} style={inputStyle} /></label>
              <label style={labelStyle}>Email<input type="email" value={inviteForm.email} onChange={(e) => setInviteForm((p) => ({ ...p, email: e.target.value }))} style={inputStyle} /></label>
              <label style={labelStyle}>
                Role
                <select value={inviteForm.role} onChange={(e) => setInviteForm((p) => ({ ...p, role: e.target.value as UserRole }))} style={{ ...inputStyle, cursor: "pointer" }}>
                  {(["owner", "admin", "standard", "viewer"] as const).map((role) => (
                    <option key={role} value={role}>{ROLE_META[role].label}</option>
                  ))}
                </select>
                <div style={{ marginTop: "4px", fontSize: "11px", color: "var(--text-tertiary)" }}>{ROLE_META[inviteForm.role].description}</div>
              </label>
              <div>
                <div style={{ ...labelStyle, marginBottom: "6px" }}>Business access</div>
                <div style={{ display: "grid", gap: "6px" }}>
                  {portfolioBusinessList.map((b) => (
                    <label key={b.id} style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", color: "var(--text-secondary)" }}>
                      <input
                        type="checkbox"
                        checked={inviteForm.businessAccess.includes(b.id)}
                        disabled={inviteForm.role === "owner" || inviteForm.role === "admin"}
                        onChange={() =>
                          setInviteForm((p) => ({
                            ...p,
                            businessAccess: p.businessAccess.includes(b.id)
                              ? p.businessAccess.filter((x) => x !== b.id)
                              : [...p.businessAccess, b.id],
                          }))
                        }
                      />
                      {b.name}
                    </label>
                  ))}
                </div>
              </div>
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px", marginTop: "16px" }}>
              <button type="button" onClick={() => setShowInviteModal(false)} style={{ border: "1px solid var(--border-md)", background: "transparent", color: "var(--text-secondary)", borderRadius: "var(--radius-md)", padding: "8px 12px", cursor: "pointer", fontFamily: "inherit" }}>Cancel</button>
              <button type="button" onClick={sendInvite} style={{ border: "none", background: "var(--green-mid)", color: "#fff", borderRadius: "var(--radius-md)", padding: "8px 12px", cursor: "pointer", fontFamily: "inherit" }}>Send invitation</button>
            </div>
          </div>
        </div>
      ) : null}

      {showRemoveModal ? (
        <div role="presentation" onClick={() => setShowRemoveModal(null)} style={{ position: "fixed", inset: 0, zIndex: 51, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", padding: "24px" }}>
          <div role="dialog" onClick={(e) => e.stopPropagation()} style={{ width: "100%", maxWidth: "380px", background: "var(--bg-primary)", borderRadius: "var(--radius-lg)", padding: "20px" }}>
            <p style={{ margin: "0 0 8px", fontSize: "16px", fontWeight: 500, color: "var(--text-primary)" }}>
              Remove {teamMembers.find((m) => m.id === showRemoveModal)?.name ?? "member"} from your team?
            </p>
            <p style={{ margin: "0 0 14px", fontSize: "14px", color: "var(--text-secondary)", lineHeight: 1.45 }}>
              They will lose access to all Opal businesses immediately.
            </p>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
              <button type="button" onClick={() => setShowRemoveModal(null)} style={{ border: "1px solid var(--border-md)", background: "transparent", color: "var(--text-secondary)", borderRadius: "var(--radius-md)", padding: "8px 12px", cursor: "pointer", fontFamily: "inherit" }}>Cancel</button>
              <button type="button" onClick={() => {
                const removed = teamMembers.find((m) => m.id === showRemoveModal);
                logAction("Team member removed", "team", removed?.email ?? showRemoveModal, {
                  userId: user.email ?? undefined,
                });
                setTeamMembers((prev) => prev.filter((m) => m.id !== showRemoveModal));
                setShowRemoveModal(null);
                setEditMemberId(null);
                setEditForm(null);
              }} style={{ border: "none", background: "var(--coral-mid)", color: "#fff", borderRadius: "var(--radius-md)", padding: "8px 12px", cursor: "pointer", fontFamily: "inherit" }}>Remove member</button>
            </div>
          </div>
        </div>
      ) : null}

      {teamToast ? (
        <div style={{ position: "fixed", right: 20, bottom: 20, zIndex: 70, background: "var(--green-light)", color: "var(--green-mid)", borderRadius: "var(--radius-lg)", padding: "12px 18px", fontSize: "13px", border: "0.5px solid var(--border)" }}>
          {teamToast}
        </div>
      ) : null}

      <AddBusinessModal
        open={addBusinessOpen}
        onClose={() => setAddBusinessOpen(false)}
        onAdded={(name) => {
          setAddBusinessToast(`✓ ${name} added to your portfolio`);
        }}
      />
      {addBusinessToast ? (
        <div
          style={{
            position: "fixed",
            left: "50%",
            bottom: "24px",
            transform: "translateX(-50%)",
            zIndex: 95,
            background: "var(--bg-primary)",
            color: "var(--text-primary)",
            borderRadius: "var(--radius-lg)",
            padding: "12px 18px",
            fontSize: "13px",
            border: "0.5px solid var(--border-md)",
            boxShadow: "0 8px 24px rgba(0,0,0,0.1)",
          }}
        >
          {addBusinessToast}
        </div>
      ) : null}
    </div>
  );
}
