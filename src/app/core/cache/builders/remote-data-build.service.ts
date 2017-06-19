import { Injectable } from "@angular/core";
import { CacheableObject } from "../object-cache.reducer";
import { ObjectCacheService } from "../object-cache.service";
import { RequestService } from "../../data/request.service";
import { ResponseCacheService } from "../response-cache.service";
import { Store } from "@ngrx/store";
import { CoreState } from "../../core.reducers";
import { RequestEntry } from "../../data/request.reducer";
import { hasValue, isNotEmpty } from "../../../shared/empty.util";
import { ResponseCacheEntry } from "../response-cache.reducer";
import { ErrorResponse, SuccessResponse } from "../response-cache.models";
import { Observable } from "rxjs/Observable";
import { RemoteData } from "../../data/remote-data";
import { GenericConstructor } from "../../shared/generic-constructor";
import { getMapsTo, getResourceType, getRelationships } from "./build-decorators";
import { NormalizedObjectFactory } from "../models/normalized-object-factory";
import { Request } from "../../data/request.models";

@Injectable()
export class RemoteDataBuildService {
  constructor(
    protected objectCache: ObjectCacheService,
    protected responseCache: ResponseCacheService,
    protected requestService: RequestService,
    protected store: Store<CoreState>,
  ) {
  }

  buildSingle<TNormalized extends CacheableObject, TDomain>(
    href: string,
    normalizedType: GenericConstructor<TNormalized>
  ): RemoteData<TDomain> {
    const requestHrefObs = this.objectCache.getRequestHrefBySelfLink(href);

    const requestObs = Observable.race(
      this.store.select<RequestEntry>('core', 'data', 'request', href).filter(entry => hasValue(entry)),
      requestHrefObs.flatMap(requestHref =>
        this.store.select<RequestEntry>('core', 'data', 'request', requestHref)).filter(entry => hasValue(entry))
    );

    const responseCacheObs = Observable.race(
      this.responseCache.get(href).filter(entry => hasValue(entry)),
      requestHrefObs.flatMap(requestHref => this.responseCache.get(requestHref)).filter(entry => hasValue(entry))
    );

    const requestPending = requestObs.map((entry: RequestEntry) => entry.requestPending).distinctUntilChanged();

    const responsePending = requestObs.map((entry: RequestEntry) => entry.responsePending).distinctUntilChanged();

    const isSuccessFul = responseCacheObs
      .map((entry: ResponseCacheEntry) => entry.response.isSuccessful).distinctUntilChanged();

    const errorMessage = responseCacheObs
      .filter((entry: ResponseCacheEntry) => !entry.response.isSuccessful)
      .map((entry: ResponseCacheEntry) => (<ErrorResponse> entry.response).errorMessage)
      .distinctUntilChanged();

    const payload = this.objectCache.getBySelfLink<TNormalized>(href, normalizedType)
      .map((normalized: TNormalized) => {
        return this.build<TNormalized, TDomain>(normalized);
      });

    return new RemoteData(
      href,
      requestPending,
      responsePending,
      isSuccessFul,
      errorMessage,
      payload
    );
  }

  buildList<TNormalized extends CacheableObject, TDomain>(
    href: string,
    normalizedType: GenericConstructor<TNormalized>
  ): RemoteData<TDomain[]> {
    const requestObs = this.store.select<RequestEntry>('core', 'data', 'request', href)
      .filter(entry => hasValue(entry));
    const responseCacheObs = this.responseCache.get(href).filter(entry => hasValue(entry));

    const requestPending = requestObs.map((entry: RequestEntry) => entry.requestPending).distinctUntilChanged();

    const responsePending = requestObs.map((entry: RequestEntry) => entry.responsePending).distinctUntilChanged();

    const isSuccessFul = responseCacheObs
      .map((entry: ResponseCacheEntry) => entry.response.isSuccessful).distinctUntilChanged();

    const errorMessage = responseCacheObs
      .filter((entry: ResponseCacheEntry) => !entry.response.isSuccessful)
      .map((entry: ResponseCacheEntry) => (<ErrorResponse> entry.response).errorMessage)
      .distinctUntilChanged();

    const payload = responseCacheObs
      .filter((entry: ResponseCacheEntry) => entry.response.isSuccessful)
      .map((entry: ResponseCacheEntry) => (<SuccessResponse> entry.response).resourceUUIDs)
      .flatMap((resourceUUIDs: Array<string>) => {
        return this.objectCache.getList(resourceUUIDs, normalizedType)
          .map((normList: TNormalized[]) => {
            return normList.map((normalized: TNormalized) => {
              return this.build<TNormalized, TDomain>(normalized);
            });
          });
      })
      .distinctUntilChanged();

    return new RemoteData(
      href,
      requestPending,
      responsePending,
      isSuccessFul,
      errorMessage,
      payload
    );
  }


  build<TNormalized extends CacheableObject, TDomain>(normalized: TNormalized): TDomain {
    let links: any = {};

    const relationships = getRelationships(normalized.constructor) || [];

    relationships.forEach((relationship: string) => {
      if (hasValue(normalized[relationship])) {
        const resourceType = getResourceType(normalized, relationship);
        const resourceConstructor = NormalizedObjectFactory.getConstructor(resourceType);
        if (Array.isArray(normalized[relationship])) {
          // without the setTimeout, the actions inside requestService.configure
          // are dispatched, but sometimes don't arrive. I'm unsure why atm.
          setTimeout(() => {
            normalized[relationship].forEach((href: string) => {
              this.requestService.configure(new Request(href))
            });
          }, 0);

          let rdArr = [];
          normalized[relationship].forEach((href: string) => {
            rdArr.push(this.buildSingle(href, resourceConstructor));
          });

          links[relationship] = this.aggregate(rdArr);
        }
        else {
          // without the setTimeout, the actions inside requestService.configure
          // are dispatched, but sometimes don't arrive. I'm unsure why atm.
          setTimeout(() => {
            this.requestService.configure(new Request(normalized[relationship]));
          },0);

          links[relationship] = this.buildSingle(normalized[relationship], resourceConstructor);
        }
      }
    });

    const domainModel = getMapsTo(normalized.constructor);
    return Object.assign(new domainModel(), normalized, links);
  }

  aggregate<T>(input: RemoteData<T>[]): RemoteData<T[]> {
    const requestPending = Observable.combineLatest(
      ...input.map(rd => rd.isRequestPending),
    ).map((...pendingArray) => pendingArray.every(e => e === true))
      .distinctUntilChanged();

    const responsePending = Observable.combineLatest(
      ...input.map(rd => rd.isResponsePending),
    ).map((...pendingArray) => pendingArray.every(e => e === true))
      .distinctUntilChanged();

    const isSuccessFul = Observable.combineLatest(
      ...input.map(rd => rd.hasSucceeded),
    ).map((...successArray) => successArray.every(e => e === true))
      .distinctUntilChanged();

    const errorMessage = Observable.combineLatest(
      ...input.map(rd => rd.errorMessage),
    ).map((...errors) => errors
      .map((e, idx) => {
        if (hasValue(e)) {
          return `[${idx}]: ${e}`;
        }
      })
      .filter(e => hasValue(e))
      .join(", ")
    );

    const payload = <Observable<T[]>> Observable.combineLatest(
      ...input.map(rd => rd.payload)
    );

    return new RemoteData(
      // This is an aggregated object, it doesn't necessarily correspond
      // to a single REST endpoint, so instead of a self link, use the
      // current time in ms for a somewhat unique id
      `${new Date().getTime()}`,
      requestPending,
      responsePending,
      isSuccessFul,
      errorMessage,
      payload
    );
  }
}
