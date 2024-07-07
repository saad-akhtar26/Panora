import { Injectable } from '@nestjs/common';
import { PrismaService } from '@@core/@core-services/prisma/prisma.service';
import { LoggerService } from '@@core/@core-services/logger/logger.service';
import { v4 as uuidv4 } from 'uuid';
import {
  InterviewStatus,
  UnifiedInterviewInput,
  UnifiedInterviewOutput,
} from '../types/model.unified';
import { FieldMappingService } from '@@core/field-mapping/field-mapping.service';
import { ApiResponse } from '@@core/utils/types';
import { OriginalInterviewOutput } from '@@core/utils/types/original/original.ats';
import { WebhookService } from '@@core/@core-services/webhooks/panora-webhooks/webhook.service';
import { ServiceRegistry } from './registry.service';
import { CoreSyncRegistry } from '@@core/@core-services/registries/core-sync.registry';
import { AtsObject } from '@ats/@lib/@types';
import { BullQueueService } from '@@core/@core-services/queues/shared.service';
import { CoreUnification } from '@@core/@core-services/unification/core-unification.service';

@Injectable()
export class InterviewService {
  constructor(
    private prisma: PrismaService,
    private logger: LoggerService,
    private webhook: WebhookService,
    private fieldMappingService: FieldMappingService,
    private serviceRegistry: ServiceRegistry,
    private coreUnification: CoreUnification,
  ) {
    this.logger.setContext(InterviewService.name);
  }

  async addInterview(
    unifiedInterviewData: UnifiedInterviewInput,
    connection_id: string,
    integrationId: string,
    linkedUserId: string,
    remote_data?: boolean,
  ): Promise<UnifiedInterviewOutput> {
    try {
      const linkedUser = await this.prisma.linked_users.findUnique({
        where: {
          id_linked_user: linkedUserId,
        },
      });

      const customFieldMappings =
        await this.fieldMappingService.getCustomFieldMappings(
          integrationId,
          linkedUserId,
          'ats.interview',
        );

      const desunifiedObject =
        await this.coreUnification.desunify<UnifiedInterviewInput>({
          sourceObject: unifiedInterviewData,
          targetType: AtsObject.interview,
          providerName: integrationId,
          vertical: 'ats',
          customFieldMappings: unifiedInterviewData.field_mappings
            ? customFieldMappings
            : [],
        });

      this.logger.log(
        'desunified object is ' + JSON.stringify(desunifiedObject),
      );

      const service = this.serviceRegistry.getService(integrationId);
      const resp: ApiResponse<OriginalInterviewOutput> =
        await service.addInterview(desunifiedObject, linkedUserId);

      const unifiedObject = (await this.coreUnification.unify<
        OriginalInterviewOutput[]
      >({
        sourceObject: [resp.data],
        targetType: AtsObject.interview,
        providerName: integrationId,
        vertical: 'ats',
        connectionId: connection_id,
        customFieldMappings: customFieldMappings,
      })) as UnifiedInterviewOutput[];

      const source_interview = resp.data;
      const target_interview = unifiedObject[0];

      const existingInterview = await this.prisma.ats_interviews.findFirst({
        where: {
          remote_id: target_interview.remote_id,
          id_connection: connection_id,
        },
      });

      let unique_ats_interview_id: string;

      if (existingInterview) {
        const data: any = {
          status: target_interview.status,
          application_id: target_interview.application_id,
          job_interview_stage_id: target_interview.job_interview_stage_id,
          organized_by: target_interview.organized_by,
          interviewers: target_interview.interviewers,
          location: target_interview.location,
          start_at: target_interview.start_at,
          end_at: target_interview.end_at,
          remote_created_at: target_interview.remote_created_at,
          remote_updated_at: target_interview.remote_updated_at,
          modified_at: new Date(),
        };

        const res = await this.prisma.ats_interviews.update({
          where: {
            id_ats_interview: existingInterview.id_ats_interview,
          },
          data: data,
        });

        unique_ats_interview_id = res.id_ats_interview;
      } else {
        const data: any = {
          id_ats_interview: uuidv4(),
          status: target_interview.status,
          application_id: target_interview.application_id,
          job_interview_stage_id: target_interview.job_interview_stage_id,
          organized_by: target_interview.organized_by,
          interviewers: target_interview.interviewers,
          location: target_interview.location,
          start_at: target_interview.start_at,
          end_at: target_interview.end_at,
          remote_created_at: target_interview.remote_created_at,
          remote_updated_at: target_interview.remote_updated_at,
          created_at: new Date(),
          modified_at: new Date(),
          remote_id: target_interview.remote_id,
          id_connection: connection_id,
        };

        const newInterview = await this.prisma.ats_interviews.create({
          data: data,
        });

        unique_ats_interview_id = newInterview.id_ats_interview;
      }

      if (
        target_interview.field_mappings &&
        target_interview.field_mappings.length > 0
      ) {
        const entity = await this.prisma.entity.create({
          data: {
            id_entity: uuidv4(),
            ressource_owner_id: unique_ats_interview_id,
          },
        });

        for (const [slug, value] of Object.entries(
          target_interview.field_mappings,
        )) {
          const attribute = await this.prisma.attribute.findFirst({
            where: {
              slug: slug,
              source: integrationId,
              id_consumer: linkedUserId,
            },
          });

          if (attribute) {
            await this.prisma.value.create({
              data: {
                id_value: uuidv4(),
                data: value || 'null',
                attribute: {
                  connect: {
                    id_attribute: attribute.id_attribute,
                  },
                },
                entity: {
                  connect: {
                    id_entity: entity.id_entity,
                  },
                },
              },
            });
          }
        }
      }

      await this.prisma.remote_data.upsert({
        where: {
          ressource_owner_id: unique_ats_interview_id,
        },
        create: {
          id_remote_data: uuidv4(),
          ressource_owner_id: unique_ats_interview_id,
          format: 'json',
          data: JSON.stringify(source_interview),
          created_at: new Date(),
        },
        update: {
          data: JSON.stringify(source_interview),
          created_at: new Date(),
        },
      });

      const result_interview = await this.getInterview(
        unique_ats_interview_id,
        undefined,
        undefined,
        remote_data,
      );

      const status_resp = resp.statusCode === 201 ? 'success' : 'fail';
      const event = await this.prisma.events.create({
        data: {
          id_event: uuidv4(),
          status: status_resp,
          type: 'ats.interview.created',
          method: 'POST',
          url: '/ats/interviews',
          provider: integrationId,
          direction: '0',
          timestamp: new Date(),
          id_linked_user: linkedUserId,
        },
      });
      await this.webhook.dispatchWebhook(
        result_interview,
        'ats.interview.created',
        linkedUser.id_project,
        event.id_event,
      );
      return result_interview;
    } catch (error) {
      throw error;
    }
  }

  async getInterview(
    id_ats_interview: string,
    linkedUserId: string,
    integrationId: string,
    remote_data?: boolean,
  ): Promise<UnifiedInterviewOutput> {
    try {
      const interview = await this.prisma.ats_interviews.findUnique({
        where: {
          id_ats_interview: id_ats_interview,
        },
      });

      // Fetch field mappings for the interview
      const values = await this.prisma.value.findMany({
        where: {
          entity: {
            ressource_owner_id: interview.id_ats_interview,
          },
        },
        include: {
          attribute: true,
        },
      });

      // Create a map to store unique field mappings
      const fieldMappingsMap = new Map();

      values.forEach((value) => {
        fieldMappingsMap.set(value.attribute.slug, value.data);
      });

      // Convert the map to an array of objects
      const field_mappings = Array.from(fieldMappingsMap, ([key, value]) => ({
        [key]: value,
      }));

      // Transform to UnifiedInterviewOutput format
      const unifiedInterview: UnifiedInterviewOutput = {
        id: interview.id_ats_interview,
        status: interview.status as InterviewStatus,
        application_id: interview.id_ats_application,
        job_interview_stage_id: interview.id_ats_job_interview_stage,
        organized_by: interview.organized_by,
        interviewers: interview.interviewers,
        location: interview.location,
        start_at: String(interview.start_at),
        end_at: String(interview.end_at),
        remote_created_at: String(interview.remote_created_at),
        remote_updated_at: String(interview.remote_updated_at),
        field_mappings: field_mappings,
        remote_id: interview.remote_id,
        created_at: interview.created_at,
        modified_at: interview.modified_at,
      };

      let res: UnifiedInterviewOutput = unifiedInterview;
      if (remote_data) {
        const resp = await this.prisma.remote_data.findFirst({
          where: {
            ressource_owner_id: interview.id_ats_interview,
          },
        });
        const remote_data = JSON.parse(resp.data);

        res = {
          ...res,
          remote_data: remote_data,
        };
      }
      if (linkedUserId && integrationId) {
        await this.prisma.events.create({
          data: {
            id_event: uuidv4(),
            status: 'success',
            type: 'ats.interview.pull',
            method: 'GET',
            url: '/ats/interview',
            provider: integrationId,
            direction: '0',
            timestamp: new Date(),
            id_linked_user: linkedUserId,
          },
        });
      }

      return res;
    } catch (error) {
      throw error;
    }
  }

  async getInterviews(
    connection_id: string,
    integrationId: string,
    linkedUserId: string,
    limit: number,
    remote_data?: boolean,
    cursor?: string,
  ): Promise<{
    data: UnifiedInterviewOutput[];
    prev_cursor: null | string;
    next_cursor: null | string;
  }> {
    try {
      let prev_cursor = null;
      let next_cursor = null;

      if (cursor) {
        const isCursorPresent = await this.prisma.ats_interviews.findFirst({
          where: {
            id_connection: connection_id,
            id_ats_interview: cursor,
          },
        });
        if (!isCursorPresent) {
          throw new ReferenceError(`The provided cursor does not exist!`);
        }
      }

      const interviews = await this.prisma.ats_interviews.findMany({
        take: limit + 1,
        cursor: cursor
          ? {
              id_ats_interview: cursor,
            }
          : undefined,
        orderBy: {
          created_at: 'asc',
        },
        where: {
          id_connection: connection_id,
        },
      });

      if (interviews.length === limit + 1) {
        next_cursor = Buffer.from(
          interviews[interviews.length - 1].id_ats_interview,
        ).toString('base64');
        interviews.pop();
      }

      if (cursor) {
        prev_cursor = Buffer.from(cursor).toString('base64');
      }

      const unifiedInterviews: UnifiedInterviewOutput[] = await Promise.all(
        interviews.map(async (interview) => {
          // Fetch field mappings for the interview
          const values = await this.prisma.value.findMany({
            where: {
              entity: {
                ressource_owner_id: interview.id_ats_interview,
              },
            },
            include: {
              attribute: true,
            },
          });

          // Create a map to store unique field mappings
          const fieldMappingsMap = new Map();

          values.forEach((value) => {
            fieldMappingsMap.set(value.attribute.slug, value.data);
          });

          // Convert the map to an array of objects
          const field_mappings = Array.from(
            fieldMappingsMap,
            ([key, value]) => ({ [key]: value }),
          );

          // Transform to UnifiedInterviewOutput format
          return {
            id: interview.id_ats_interview,
            status: interview.status as InterviewStatus,
            application_id: interview.id_ats_application,
            job_interview_stage_id: interview.id_ats_job_interview_stage,
            organized_by: interview.organized_by,
            interviewers: interview.interviewers,
            location: interview.location,
            start_at: String(interview.start_at),
            end_at: String(interview.end_at),
            remote_created_at: String(interview.remote_created_at),
            remote_updated_at: String(interview.remote_updated_at),
            field_mappings: field_mappings,
            remote_id: interview.remote_id,
            created_at: interview.created_at,
            modified_at: interview.modified_at,
          };
        }),
      );

      let res: UnifiedInterviewOutput[] = unifiedInterviews;

      if (remote_data) {
        const remote_array_data: UnifiedInterviewOutput[] = await Promise.all(
          res.map(async (interview) => {
            const resp = await this.prisma.remote_data.findFirst({
              where: {
                ressource_owner_id: interview.id,
              },
            });
            const remote_data = JSON.parse(resp.data);
            return { ...interview, remote_data };
          }),
        );

        res = remote_array_data;
      }

      await this.prisma.events.create({
        data: {
          id_event: uuidv4(),
          status: 'success',
          type: 'ats.interview.pull',
          method: 'GET',
          url: '/ats/interviews',
          provider: integrationId,
          direction: '0',
          timestamp: new Date(),
          id_linked_user: linkedUserId,
        },
      });
      return {
        data: res,
        prev_cursor,
        next_cursor,
      };
    } catch (error) {
      throw error;
    }
  }

  async updateInterview(
    id: string,
    updateInterviewData: Partial<UnifiedInterviewInput>,
  ): Promise<UnifiedInterviewOutput> {
    try {
    } catch (error) {}
    return;
  }
}
