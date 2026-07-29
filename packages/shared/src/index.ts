export type UserRole = "client" | "executor" | "operator" | "quality_manager" | "manager" | "admin";

export type OrderStatus =
  | "CREATED"
  | "PRICED"
  | "CONFIRMED"
  | "ASSIGNED"
  | "ACCEPTED"
  | "IN_PROGRESS"
  | "QUALITY_CHECK"
  | "COMPLETED"
  | "PAYMENT_RELEASED"
  | "DISPUTE";

export type CleaningService = {
  id: string;
  title: string;
  basePrice: number;
  durationMinutes: number;
  mvp: boolean;
};

export const mvpCleaningServices: CleaningService[] = [
  { id: "standard_apartment", title: "Standard apartment cleaning", basePrice: 18000, durationMinutes: 150, mvp: true },
  { id: "deep_cleaning", title: "Deep cleaning", basePrice: 32000, durationMinutes: 240, mvp: true },
  { id: "office_cleaning", title: "Office cleaning", basePrice: 42000, durationMinutes: 300, mvp: true },
  { id: "post_renovation", title: "Post-renovation cleaning", basePrice: 55000, durationMinutes: 360, mvp: false }
];

export type PriceInput = {
  serviceId: string;
  rooms: number;
  areaSqm: number;
  hasPets: boolean;
  urgent: boolean;
};

export type PriceEstimate = {
  serviceId: string;
  total: number;
  complexityScore: number;
  explanation: string[];
};

export function estimateOrderPrice(input: PriceInput): PriceEstimate {
  const service = mvpCleaningServices.find((item) => item.id === input.serviceId) ?? mvpCleaningServices[0];
  const areaFactor = Math.max(1, input.areaSqm / 45);
  const roomFactor = Math.max(1, input.rooms * 0.18);
  const petFee = input.hasPets ? 3500 : 0;
  const urgentFee = input.urgent ? 6000 : 0;
  const complexityScore = Math.min(100, Math.round(areaFactor * 28 + roomFactor * 12 + (input.hasPets ? 10 : 0) + (input.urgent ? 14 : 0)));
  const total = Math.round(service.basePrice * areaFactor + service.basePrice * roomFactor * 0.2 + petFee + urgentFee);

  return {
    serviceId: service.id,
    total,
    complexityScore,
    explanation: [
      `Base service: ${service.title}`,
      `Area factor: ${areaFactor.toFixed(2)}`,
      input.hasPets ? "Pet cleaning surcharge applied" : "No pet surcharge",
      input.urgent ? "Urgent order surcharge applied" : "Standard scheduling"
    ]
  };
}

export type ExecutorCandidate = {
  id: string;
  name: string;
  distanceKm: number;
  rating: number;
  activeOrders: number;
  completedOrders: number;
};

export function scoreExecutor(candidate: ExecutorCandidate): number {
  const distanceScore = Math.max(0, 35 - candidate.distanceKm * 4);
  const ratingScore = candidate.rating * 10;
  const loadScore = Math.max(0, 20 - candidate.activeOrders * 5);
  const experienceScore = Math.min(15, candidate.completedOrders / 8);
  return Math.round(distanceScore + ratingScore + loadScore + experienceScore);
}
