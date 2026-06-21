import express from 'express'
import type { Router } from 'express'
import EmployeesController from './controller'

const employeeController = new EmployeesController();

export const empRouter:Router = express.Router()

empRouter.post('/register-face', employeeController.handleRegisterFace.bind(employeeController) )
empRouter.post('/register-employee', employeeController.handleEployeeRegister.bind(employeeController) )
empRouter.post('/add-client-location', employeeController.createClientLocation.bind(employeeController) )
empRouter.post('/assign-location', employeeController.assignLocationToEmployee.bind(employeeController) )
empRouter.post('/attendance/mark', employeeController.handleattendanceMark.bind(employeeController) )