import { minLength, pipe, strictObject, string } from "valibot";

/** The body every Review recovery route, and leaving a Review, takes; neither opens the Review, so it never carries `recordOpen`. */
export const reviewRecoverySchema = strictObject({
  profileId: pipe(string(), minLength(1)),
  reviewId: pipe(string(), minLength(1)),
});
