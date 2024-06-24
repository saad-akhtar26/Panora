import { Injectable, OnModuleInit } from '@nestjs/common';
import { LoggerService } from '@@core/logger/logger.service';
import { PrismaService } from '@@core/prisma/prisma.service';
import { Cron } from '@nestjs/schedule';
import { v4 as uuidv4 } from 'uuid';
import { FieldMappingService } from '@@core/field-mapping/field-mapping.service';
import { ServiceRegistry } from '../services/registry.service';
import { WebhookService } from '@@core/webhook/webhook.service';
import { Queue } from 'bull';
import { InjectQueue } from '@nestjs/bull';
import { CoreUnification } from '@@core/utils/services/core.service';
import { ApiResponse } from '@@core/utils/types';
import { IGroupService } from '../types';
import { UnifiedGroupOutput } from '../types/model.unified';
import { fs_groups as FileStorageGroup } from '@prisma/client';
import { FILESTORAGE_PROVIDERS } from '@panora/shared';
import { FileStorageObject } from '@filestorage/@lib/@types';
import { OriginalGroupOutput } from '@@core/utils/types/original/original.file-storage';

@Injectable()
export class SyncService implements OnModuleInit {
  constructor(
    private prisma: PrismaService,
    private logger: LoggerService,
    private webhook: WebhookService,
    private fieldMappingService: FieldMappingService,
    private serviceRegistry: ServiceRegistry,
    private coreUnification: CoreUnification,
    @InjectQueue('syncTasks') private syncQueue: Queue,
  ) {
    this.logger.setContext(SyncService.name);
  }

  async onModuleInit() {
    try {
      await this.scheduleSyncJob();
    } catch (error) {
      throw error;
    }
  }

  private async scheduleSyncJob() {
    const jobName = 'filestorage-sync-groups';

    // Remove existing jobs to avoid duplicates in case of application restart
    const jobs = await this.syncQueue.getRepeatableJobs();
    for (const job of jobs) {
      if (job.name === jobName) {
        await this.syncQueue.removeRepeatableByKey(job.key);
      }
    }
    // Add new job to the queue with a CRON expression
    await this.syncQueue.add(
      jobName,
      {},
      {
        repeat: { cron: '0 0 * * *' }, // Runs once a day at midnight
      },
    );
  }

  @Cron('0 */8 * * *') // every 8 hours
  async syncGroups(user_id?: string) {
    try {
      this.logger.log('Syncing groups...');
      const users = user_id
        ? [
            await this.prisma.users.findUnique({
              where: {
                id_user: user_id,
              },
            }),
          ]
        : await this.prisma.users.findMany();
      if (users && users.length > 0) {
        for (const user of users) {
          const projects = await this.prisma.projects.findMany({
            where: {
              id_user: user.id_user,
            },
          });
          for (const project of projects) {
            const id_project = project.id_project;
            const linkedUsers = await this.prisma.linked_users.findMany({
              where: {
                id_project: id_project,
              },
            });
            linkedUsers.map(async (linkedUser) => {
              try {
                const providers = FILESTORAGE_PROVIDERS;
                for (const provider of providers) {
                  try {
                    await this.syncGroupsForLinkedUser(
                      provider,
                      linkedUser.id_linked_user,
                      id_project,
                    );
                  } catch (error) {
                    throw error;
                  }
                }
              } catch (error) {
                throw error;
              }
            });
          }
        }
      }
    } catch (error) {
      throw error;
    }
  }

  async syncGroupsForLinkedUser(
    integrationId: string,
    linkedUserId: string,
    id_project: string,
  ) {
    try {
      this.logger.log(
        `Syncing ${integrationId} groups for linkedUser ${linkedUserId}`,
      );
      // check if linkedUser has a connection if not just stop sync
      const connection = await this.prisma.connections.findFirst({
        where: {
          id_linked_user: linkedUserId,
          provider_slug: integrationId,
          vertical: 'filestorage',
        },
      });
      if (!connection) {
        this.logger.warn(
          `Skipping groups syncing... No ${integrationId} connection was found for linked user ${linkedUserId} `,
        );
        return;
      }
      // get potential fieldMappings and extract the original properties name
      const customFieldMappings =
        await this.fieldMappingService.getCustomFieldMappings(
          integrationId,
          linkedUserId,
          'filestorage.group',
        );
      const remoteProperties: string[] = customFieldMappings.map(
        (mapping) => mapping.remote_id,
      );

      const service: IGroupService =
        this.serviceRegistry.getService(integrationId);
      const resp: ApiResponse<OriginalGroupOutput[]> = await service.syncGroups(
        linkedUserId,
        remoteProperties,
      );

      const sourceObject: OriginalGroupOutput[] = resp.data;

      // unify the data according to the target obj wanted
      const unifiedObject = (await this.coreUnification.unify<
        OriginalGroupOutput[]
      >({
        sourceObject,
        targetType: FileStorageObject.group,
        providerName: integrationId,
        vertical: 'filestorage',
        customFieldMappings,
      })) as UnifiedGroupOutput[];

      // insert the data in the DB with the fieldMappings (value table)
      const groups_data = await this.saveGroupsInDb(
        connection.id_connection,
        linkedUserId,
        unifiedObject,
        integrationId,
        sourceObject,
      );
      const event = await this.prisma.events.create({
        data: {
          id_event: uuidv4(),
          status: 'success',
          type: 'filestorage.group.pulled',
          method: 'PULL',
          url: '/pull',
          provider: integrationId,
          direction: '0',
          timestamp: new Date(),
          id_linked_user: linkedUserId,
        },
      });
      await this.webhook.handleWebhook(
        groups_data,
        'filestorage.group.pulled',
        id_project,
        event.id_event,
      );
    } catch (error) {
      throw error;
    }
  }

  async saveGroupsInDb(
    connection_id: string,
    linkedUserId: string,
    groups: UnifiedGroupOutput[],
    originSource: string,
    remote_data: Record<string, any>[],
  ): Promise<FileStorageGroup[]> {
    try {
      let groups_results: FileStorageGroup[] = [];
      for (let i = 0; i < groups.length; i++) {
        const group = groups[i];
        const originId = group.remote_id;

        if (!originId || originId === '') {
          throw new ReferenceError(`Origin id not there, found ${originId}`);
        }

        const existingGroup = await this.prisma.fs_groups.findFirst({
          where: {
            remote_id: originId,
            id_connection: connection_id,
          },
        });

        let unique_fs_group_id: string;

        if (existingGroup) {
          // Update the existing group
          let data: any = {
            modified_at: new Date(),
          };
          if (group.name) {
            data = { ...data, name: group.name };
          }
          if (group.users) {
            data = { ...data, users: group.users };
          }
          if (group.remote_was_deleted) {
            data = { ...data, remote_was_deleted: group.remote_was_deleted };
          }
          const res = await this.prisma.fs_groups.update({
            where: {
              id_fs_group: existingGroup.id_fs_group,
            },
            data: data,
          });
          unique_fs_group_id = res.id_fs_group;
          groups_results = [...groups_results, res];
        } else {
          // Create a new group
          this.logger.log('Group does not exist, creating a new one');
          const uuid = uuidv4();
          let data: any = {
            id_fs_group: uuid,
            created_at: new Date(),
            modified_at: new Date(),
            remote_id: originId,
            id_connection: connection_id,
          };

          if (group.name) {
            data = { ...data, name: group.name };
          }
          if (group.users) {
            data = { ...data, users: group.users };
          }
          if (group.remote_was_deleted) {
            data = { ...data, remote_was_deleted: group.remote_was_deleted };
          }

          const newGroup = await this.prisma.fs_groups.create({
            data: data,
          });

          unique_fs_group_id = newGroup.id_fs_group;
          groups_results = [...groups_results, newGroup];
        }

        // check duplicate or existing values
        if (group.field_mappings && group.field_mappings.length > 0) {
          const entity = await this.prisma.entity.create({
            data: {
              id_entity: uuidv4(),
              ressource_owner_id: unique_fs_group_id,
            },
          });

          for (const [slug, value] of Object.entries(group.field_mappings)) {
            const attribute = await this.prisma.attribute.findFirst({
              where: {
                slug: slug,
                source: originSource,
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

        // insert remote_data in db
        await this.prisma.remote_data.upsert({
          where: {
            ressource_owner_id: unique_fs_group_id,
          },
          create: {
            id_remote_data: uuidv4(),
            ressource_owner_id: unique_fs_group_id,
            format: 'json',
            data: JSON.stringify(remote_data[i]),
            created_at: new Date(),
          },
          update: {
            data: JSON.stringify(remote_data[i]),
            created_at: new Date(),
          },
        });
      }
      return groups_results;
    } catch (error) {
      throw error;
    }
  }
}
