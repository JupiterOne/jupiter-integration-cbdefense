import Axios, * as axios from "axios";
import { Opaque } from "type-fest";

import {
  IntegrationError,
  IntegrationInstanceAuthenticationError,
  IntegrationLogger,
} from "@jupiterone/jupiter-managed-integration-sdk";

import { CarbonBlackIntegrationConfig } from "./types";

export type CarbonBlackAccount = Opaque<any, "CarbonBlackAccount">;
export type CarbonBlackDeviceSensor = Opaque<any, "CarbonBlackDeviceSensor">;
export type CarbonBlackAlert = Opaque<any, "CarbonBlackAlert">;

export default class CbDefenseClient {
  /**
   * The Carbon Black cloud site, `eap01` in `https://defense-eap01.conferdeploy.net`.
   */
  private site: string;

  /**
   * @see https://developer.carbonblack.com/reference/carbon-black-cloud/authentication/#explaining-the-url-parts
   */
  private platformBaseUrl: string;

  private axiosInstance: axios.AxiosInstance;
  private logger: IntegrationLogger;

  constructor(config: CarbonBlackIntegrationConfig, logger: IntegrationLogger) {
    this.site = config.site;

    this.platformBaseUrl = `https://defense-${
      this.site
    }.conferdeploy.net/appservices/v6/orgs/${config.orgKey}`;

    this.logger = logger;
    this.axiosInstance = Axios.create({
      headers: {
        "X-Auth-Token": `${config.apiKey}/${config.connectorId}`,
      },
    });
  }

  public async getAccountDetails(): Promise<CarbonBlackAccount> {
    try {
      const response = await this.axiosInstance.post(
        `${this.platformBaseUrl}/devices/_search`,
        {
          rows: 1,
          start: 0,
        },
      );

      const devices = response.data.results;
      if (devices && devices.length > 0) {
        return {
          site: this.site,
          organization_name: devices[0].organization_name as string,
          organization_id: devices[0].organization_id,
        };
      } else {
        throw new IntegrationError(
          "Unable to retrieve account details, no device sensor found",
        );
      }
    } catch (err) {
      if (err.status === 401) {
        throw new IntegrationInstanceAuthenticationError(err);
      } else {
        throw new IntegrationError({
          cause: err,
          message: "Unable to retrieve account details",
        });
      }
    }
  }

  public async iterateDevices(
    callback: (agent: CarbonBlackDeviceSensor) => void,
  ): Promise<void> {
    const url = "/devices/_search";

    try {
      await this.iterateResults({
        platformPath: url,
        callback,
      });
    } catch (err) {
      this.logger.info(
        {
          err,
        },
        "Encounted error retrieving devices",
      );
      const response = err.response || {};

      // CB API seems returns 500 errors for empty results
      if (response.status !== 500) {
        throw new IntegrationError({
          cause: err,
          code: `TENABLE_CLIENT_API_${response.status}_ERROR`,
          statusCode: response.status,
          message: `${response.statusText}: ${response.status} post ${url}`,
        });
      }
    }
  }

  public async iterateAlerts(
    callback: (alert: CarbonBlackAlert) => void,
    alertsSince: Date,
  ): Promise<void> {
    const url = "/alerts/_search";

    try {
      await this.iterateResults({
        platformPath: url,
        criteria: {
          create_time: {
            start: alertsSince.toISOString(),
            end: new Date().toISOString(),
          },
        },
        callback,
      });
    } catch (err) {
      this.logger.info(
        {
          err,
        },
        "Encounted error retrieving alerts",
      );
      const response = err.response || {};
      // CB API seems returns 500 errors for empty results
      if (response.status !== 500) {
        throw new IntegrationError({
          cause: err,
          code: `TENABLE_CLIENT_API_${response.status}_ERROR`,
          statusCode: response.status,
          message: `${response.statusText}: ${response.status} post ${url}`,
        });
      }
    }
  }

  private async iterateResults<T>({
    platformPath,
    criteria,
    callback,
  }: {
    platformPath: string;
    criteria?: {
      create_time: {
        start: string;
        end: string;
      };
    };
    callback: (agent: T) => void;
  }): Promise<void> {
    const platformUrl = `${this.platformBaseUrl}${platformPath}`;
    const rows = 200;

    let pagesProcessed = 0;
    let rowsProcessed = 0;
    let finished = false;

    while (!finished) {
      const start = rowsProcessed;

      const response = await this.axiosInstance.post(platformUrl, {
        rows,
        start,
        criteria,
      });
      const results = response.data.results;

      pagesProcessed++;
      rowsProcessed += results.length;
      finished = response.data.num_found <= rowsProcessed;

      this.logger.info(
        {
          found: response.data.num_found,
          rowsProcessed,
          rowsTotal: rowsProcessed,
          pagesProcessed,
          finished,
        },
        `Fetched page for ${platformUrl}`,
      );

      results.forEach(callback);
    }
  }
}
