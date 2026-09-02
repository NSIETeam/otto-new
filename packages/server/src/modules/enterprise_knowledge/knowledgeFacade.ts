/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import {
  addEnterpriseKnowledgeInRepository,
  deleteEnterpriseKnowledgeInRepository,
  listEnterpriseKnowledgeForAdministrationFromRepository,
  listEnterpriseKnowledgeForBackupFromRepository,
  listEnterpriseKnowledgeFromRepository,
  listEnterpriseKnowledgeRevisionsFromRepository,
  listMemberEnterpriseKnowledgeFromRepository,
  reviewEnterpriseKnowledgeInRepository,
  revalidateEnterpriseKnowledgeInRepository,
  reviseEnterpriseKnowledgeInRepository,
  saveEnterpriseKnowledgeInRepository,
  searchEnterpriseKnowledgeInRepository,
  type AddEnterpriseKnowledgeInput,
  type EnterpriseKnowledgeStatus,
  type ReviseEnterpriseKnowledgeInput,
  type RevalidateEnterpriseKnowledgeInput,
  type EnterpriseKnowledgeRepositoryStore,
} from './knowledgeRepository.js';
import {
  listEnterpriseKnowledgeEvidenceInRepository,
  observeEnterpriseKnowledgeInRepository,
  type ObserveEnterpriseKnowledgeInput,
} from './knowledgeRetentionRepository.js';

export function createEnterpriseKnowledgeFacade(
  store: EnterpriseKnowledgeRepositoryStore,
) {
  return {
    observeKnowledge(input: ObserveEnterpriseKnowledgeInput) {
      return observeEnterpriseKnowledgeInRepository(store, input);
    },
    addKnowledge(input: AddEnterpriseKnowledgeInput) {
      return addEnterpriseKnowledgeInRepository(store, input);
    },
    saveKnowledge(input: AddEnterpriseKnowledgeInput) {
      return saveEnterpriseKnowledgeInRepository(store, input);
    },
    deleteKnowledge(input: { id: number; organizationId?: string }) {
      return deleteEnterpriseKnowledgeInRepository(store, input);
    },
    getKnowledge(
      department?: string,
      category?: string,
      organizationId?: string,
    ) {
      return listEnterpriseKnowledgeFromRepository(
        store,
        department,
        category,
        organizationId,
      );
    },
    searchKnowledge(
      query: string,
      department?: string,
      organizationId?: string,
    ) {
      return searchEnterpriseKnowledgeInRepository(
        store,
        query,
        department,
        organizationId,
      );
    },
    getMemberKnowledge(
      memberDepartment: string | null | undefined,
      query = '',
      organizationId?: string,
      options: { includeOwnPending?: boolean; contributorAccountId?: string } = {},
    ) {
      return listMemberEnterpriseKnowledgeFromRepository(
        store,
        memberDepartment,
        query,
        organizationId,
        options,
      );
    },
    getKnowledgeForAdministration(
      query = '',
      department?: string,
      organizationId?: string,
      status?: EnterpriseKnowledgeStatus,
    ) {
      return listEnterpriseKnowledgeForAdministrationFromRepository(
        store,
        query,
        department,
        organizationId,
        status,
      );
    },
    getKnowledgeForBackup(organizationId?: string) {
      return listEnterpriseKnowledgeForBackupFromRepository(store, organizationId);
    },
    reviewKnowledge(input: {
      id: number;
      organizationId?: string;
      action: 'approve' | 'archive';
      reviewer: string;
      note?: string;
    }) {
      return reviewEnterpriseKnowledgeInRepository(store, input);
    },
    reviseKnowledge(input: ReviseEnterpriseKnowledgeInput) {
      return reviseEnterpriseKnowledgeInRepository(store, input);
    },
    revalidateKnowledge(input: RevalidateEnterpriseKnowledgeInput) {
      return revalidateEnterpriseKnowledgeInRepository(store, input);
    },
    getKnowledgeRevisions(id: number, organizationId?: string) {
      return listEnterpriseKnowledgeRevisionsFromRepository(store, id, organizationId);
    },
    getKnowledgeEvidence(id: number, organizationId?: string) {
      return listEnterpriseKnowledgeEvidenceInRepository(store, id, organizationId);
    },
  };
}
