import { minLength, pipe, strictObject, string } from "valibot";

/** The body every Review recovery route takes; recovery reloads the workbench already on screen, so it never carries `recordOpen`. */
export const reviewRecoverySchema = strictObject({
  profileId: pipe(string(), minLength(1)),
  reviewId: pipe(string(), minLength(1)),
});
