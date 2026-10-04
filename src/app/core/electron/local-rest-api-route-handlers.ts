import { InjectionToken } from '@angular/core';
import {
  LocalRestApiRequestPayload,
  LocalRestApiResponsePayload,
} from '../../../../electron/shared-with-frontend/local-rest-api.model';

/**
 * Routes of the Local REST API that live with the feature they expose, so
 * core/ does not have to import features/ (see FEATURE_LAYER_FENCE in
 * eslint.config.js). Each feature provides one handler from main.ts with
 * `multi: true`.
 */
export interface LocalRestApiRouteHandler {
  /**
   * Answers the request if its method and path belong to this handler;
   * resolves to `undefined` otherwise, so the next handler (and finally the
   * 404) gets it.
   */
  handle(
    request: LocalRestApiRequestPayload,
  ): Promise<LocalRestApiResponsePayload | undefined>;
}

export const LOCAL_REST_API_ROUTE_HANDLERS = new InjectionToken<
  readonly LocalRestApiRouteHandler[]
>('LOCAL_REST_API_ROUTE_HANDLERS');
